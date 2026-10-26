// 責務: 実行記録と open な PR の一覧から、衝突を解かせる PR を選び、ロックを取った後に解かせてよいかを決める純粋関数だけを担う。
//
// 設計意図（WHY）:
// - このツールが作った PR だけを選び、実行記録に URL が残っているかで見分ける。PR はどれも pipeline.yml が作り、
//   対話セッションも同じ形のブランチ名を使うので、作成者やブランチ名では見分けられない。人間が作業中のブランチへ
//   merge コミットを push すると、人間の次の push が拒否される（Issue #1076）。
// - PR の head が、このツールが最後に CI を待った commit のままのときだけ解かせる。後から人間や別の仕組みが push した
//   ブランチは、もうこのツールの持ち物ではない。その中身を、権限確認を飛ばした無人セッションと `npm ci` で走らせない。
// - mergeable が CONFLICTING の PR だけを選ぶ。UNKNOWN は GitHub がまだ計算していないだけなので、次の巡回で見直す。
// - `needs-human-check` が付いた Issue の PR は解かせない。解けずに離脱した PR を、人間が見るまで何度も解かせ直さない。
// - I/O も import も持たない層をここに切り出すことで、GitHub に触れずに確かめられる。

const CONFLICTING_MERGEABLE_STATE = 'CONFLICTING'

// selectConflictedOwnPullRequests が読む項目。`gh pr list --json` に渡す側と読む側で食い違うと、衝突を常に見落とす
export const CONFLICT_CHECK_PULL_REQUEST_FIELDS = 'number,url,headRefName,mergeable'

/**
 * 実行記録から、このツールが作った PR を URL ごとに集める。同じ PR の記録が何件もあれば、後の記録を採る。
 *
 * ただし後の記録が CI を待っていなければ（セッションが落ちた・push せずに離脱した）、前の記録の commit を残す。
 * 空で上書きすると、人間が確かめて `needs-human-check` を外しても、二度と解かせ直せなくなる。
 * その回にこのツールが push していれば、head が残した commit と食い違うので、解かせる前の照合で飛ばされる。
 *
 * PR の URL が無い記録と、Issue 番号が整数でない記録は飛ばす。
 *
 * @param {Record<string, unknown>[]} runRecords 実行記録（古い順）
 * @returns {Map<string, { issueNumber: number, lastWaitedHeadSha: string | null }>} PR の URL から、Issue 番号と、最後に CI を待った commit の SHA への対応
 */
export function collectOwnPullRequestsByUrl(runRecords) {
  const ownPullRequestsByUrl = new Map()
  for (const runRecord of runRecords) {
    const { pullRequestUrl, issueNumber } = runRecord
    if (typeof pullRequestUrl !== 'string' || pullRequestUrl === '') continue
    if (!Number.isInteger(issueNumber)) continue
    const lastWaitedHeadSha =
      readLastWaitedHeadSha(runRecord) ??
      ownPullRequestsByUrl.get(pullRequestUrl)?.lastWaitedHeadSha ??
      null
    ownPullRequestsByUrl.set(pullRequestUrl, { issueNumber, lastWaitedHeadSha })
  }
  return ownPullRequestsByUrl
}

/**
 * open な PR のうち、このツールが作り、衝突しているものを、PR 番号の小さい順に選ぶ。
 *
 * @param {{ openPullRequests: { number: number, url: string, headRefName: string, mergeable: string }[], ownPullRequestsByUrl: ReturnType<typeof collectOwnPullRequestsByUrl> }} params CONFLICT_CHECK_PULL_REQUEST_FIELDS で引いた `gh pr list --json` の出力と、collectOwnPullRequestsByUrl の結果
 * @returns {{ pullRequestNumber: number, pullRequestUrl: string, branchName: string, issueNumber: number, lastWaitedHeadSha: string | null }[]} 衝突を解かせる候補
 */
export function selectConflictedOwnPullRequests({ openPullRequests, ownPullRequestsByUrl }) {
  return openPullRequests
    .filter(
      ({ url, mergeable }) =>
        mergeable === CONFLICTING_MERGEABLE_STATE && ownPullRequestsByUrl.has(url)
    )
    .sort((left, right) => left.number - right.number)
    .map(({ number, url, headRefName }) => ({
      pullRequestNumber: number,
      pullRequestUrl: url,
      branchName: headRefName,
      ...ownPullRequestsByUrl.get(url)
    }))
}

/**
 * ロックを取った後に PR と Issue を読み直した結果から、衝突を解かせずに飛ばす理由を探す。
 *
 * 候補は巡回の頭で1回しか引かないので、他のプロセスが解いた後や、離脱して `needs-human-check` を付けた後のことがある。
 *
 * @param {{ pullRequest: { state: string, mergeable: string, headSha: string }, issue: { number: number, state: string, labelNames: string[] }, lastWaitedHeadSha: string | null, needsHumanCheckLabel: string }} params 読み直した PR（state は 'OPEN' など）と Issue（state は 'OPEN' / 'CLOSED'）・このツールが最後に CI を待った commit の SHA（記録に無ければ null）・`needs-human-check` のラベル名
 * @returns {string | null} 飛ばす理由（解かせてよければ null）
 */
export function findReasonNotToResolveConflict({
  pullRequest,
  issue,
  lastWaitedHeadSha,
  needsHumanCheckLabel
}) {
  if (pullRequest.state !== 'OPEN')
    return `PR がもう open ではありません（いまは ${pullRequest.state}）`
  if (pullRequest.mergeable !== CONFLICTING_MERGEABLE_STATE) {
    return `PR がもう衝突していません（mergeable はいま ${pullRequest.mergeable}）`
  }
  if (lastWaitedHeadSha === null) {
    return 'このツールが CI を待った記録が無いので、中身を確かめられません（人間が見てください）'
  }
  if (pullRequest.headSha !== lastWaitedHeadSha) {
    return 'このツールが最後に CI を待った commit の後に、別の push があります（人間か別の仕組みが引き取ったので触りません）'
  }
  if (issue.state !== 'OPEN') return `#${issue.number} が閉じています`
  // GitHub のラベル名は大文字小文字を区別しない
  if (
    issue.labelNames.some(
      (labelName) => labelName.toLowerCase() === needsHumanCheckLabel.toLowerCase()
    )
  ) {
    return `#${issue.number} に ${needsHumanCheckLabel} が付いています`
  }
  return null
}

/**
 * 実行記録の1件から、このツールが最後に CI を待った commit の SHA を読む。
 *
 * @param {{ ciRuns?: unknown }} runRecord 実行記録の1件
 * @returns {string | null} 最後に CI を待った commit の SHA（CI を待っていなければ null）
 */
function readLastWaitedHeadSha(runRecord) {
  if (!Array.isArray(runRecord.ciRuns)) return null
  const lastCiRun = runRecord.ciRuns.at(-1)
  return typeof lastCiRun?.headSha === 'string' ? lastCiRun.headSha : null
}
