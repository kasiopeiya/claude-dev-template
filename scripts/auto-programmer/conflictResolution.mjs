// 責務: 衝突した PR 1件のブランチへ切り替えて `/auto-resolve-conflict` に解かせ、push されたら CI が通るまで見届けるところまでを担う。
//
// 設計意図（WHY）:
// - 解かせると決めた PR（ClaimedConflictedPullRequest）を受け取るところから始める。PR を拾って Issue のロックを取るのは
//   conflictedPullRequestClaim.mjs で、このモジュールは拾った後の「解かせる」だけを持つ。
// - 記録の決まり（runWorkAndRecord）と CI を待って直させる処理（watchCiAndFix）は index.mjs が持つ。Issue の実装にも同じものを
//   使うので、ここへ移さない。呼び出し側を import すると循環するので、引数で受ける。呼び出し側からこのモジュールへの一方向にする。

import { hasSessionSucceeded, runAutoResolveConflictSession } from './claudeSession.mjs'
import { ensureDependencies } from './preflight.mjs'
import { disableAutoMerge } from './pullRequestQuery.mjs'
import { stopSignal } from './stopSignals.mjs'
import { showInfo, showIssueBanner } from './ui.mjs'
import { switchToPullRequestBranch } from './workspace.mjs'

/** @typedef {import('./conflictedPullRequestClaim.mjs').ClaimedConflictedPullRequest} ClaimedConflictedPullRequest */

/** @typedef {(params: { record: Record<string, unknown> & { issueNumber: number }, runWork: (record: Record<string, unknown>, workStartedAt: string) => Promise<boolean>, readPullRequestUrl: () => string | null }) => Promise<boolean>} RunWorkAndRecord 作業を走らせ、途中で落ちても結果を記録する */

/** @typedef {(target: { issueNumber: number, branchName: string, workspaceDir: string, headShaBeforeSession: string | null, sessionName: string, workStartedAt: string }, record: Record<string, unknown>) => Promise<boolean>} WatchCiAndFix push した commit の CI を待ち、落ちていれば直させる */

/**
 * 衝突した PR 1件を解かせて CI まで見届け、結果を記録する（記録の決まりは runWorkAndRecord）。
 *
 * @param {{ conflictedPullRequest: ClaimedConflictedPullRequest, workspaceDir: string, runWorkAndRecord: RunWorkAndRecord, watchCiAndFix: WatchCiAndFix }} params 解かせると決めた PR・このプロセスが使う AI 専用 clone・記録の決まり・CI を待って直させる処理
 * @returns {Promise<boolean>} 走らせた claude セッションがすべて正常終了したら true
 * @throws {Error} 記録ファイルへ書けなかったとき
 */
export function resolveConflictAndRecord({
  conflictedPullRequest,
  workspaceDir,
  runWorkAndRecord,
  watchCiAndFix
}) {
  const { issueNumber, pullRequestNumber, pullRequestUrl, branchName } = conflictedPullRequest
  showIssueBanner({
    issueNumber,
    title: `PR #${pullRequestNumber} の衝突を解く`,
    branchName,
    workspaceDir
  })
  return runWorkAndRecord({
    record: { issueNumber, branchName, workspaceDir, isConflictResolution: true },
    runWork: (record, workStartedAt) =>
      resolveConflictAndWatchCi(
        { conflictedPullRequest, workspaceDir, watchCiAndFix },
        record,
        workStartedAt
      ),
    // 解いた後も PR の URL を記録に残し、次に衝突したときもこのツールの PR として見分ける
    readPullRequestUrl: () => pullRequestUrl
    // speakRunOutcome は渡さず、読み上げない。衝突した PR を解くのは Issue を終えることではなく、読み上げの範囲は
    // 「Issue を1件終えるたび」だから。この回の記録にはタイトルも無い
  })
}

/**
 * 衝突した PR のブランチへ切り替えて `/auto-resolve-conflict` に解かせ、push されたら CI が通るまで直させる。結果は record へ書き足す。
 *
 * @param {{ conflictedPullRequest: ClaimedConflictedPullRequest, workspaceDir: string, watchCiAndFix: WatchCiAndFix }} params 解かせると決めた PR・このプロセスが使う AI 専用 clone・CI を待って直させる処理
 * @param {Record<string, unknown>} record 書き足す先の記録
 * @param {string} workStartedAt 今回の作業を始めた時刻（ISO 8601）
 * @returns {Promise<boolean>} 走らせた claude セッションがすべて正常終了したら true
 * @throws {Error} git・gh・claude を起動できなかった／失敗したとき
 */
async function resolveConflictAndWatchCi(
  { conflictedPullRequest, workspaceDir, watchCiAndFix },
  record,
  workStartedAt
) {
  const { issueNumber, pullRequestNumber, branchName, headShaBeforeSession, isAutoMergeEnabled } =
    conflictedPullRequest
  // 外さずに解くと、解いた push の CI が通った瞬間、pr-ai-triage が中身を見る前にマージされうる。
  // 外したことを記録に残す。push されずに終わると pr-ai-triage が走らず、外れたまま残るので、人間が記録から気づけるようにする
  if (isAutoMergeEnabled) {
    disableAutoMerge(pullRequestNumber)
    showInfo(
      `PR #${pullRequestNumber} の auto-merge を外しました。解いた後の CI が通ると、pr-ai-triage が中身を見て付け直します`
    )
    record.isAutoMergeDisabled = true
  }
  // リモートの最新ではなく、確かめた commit へ切り替える。確かめた後に入った push の中身を、無人セッションで走らせない
  switchToPullRequestBranch({ workspaceDir, branchName, headSha: headShaBeforeSession })
  ensureDependencies(workspaceDir)
  const resolveStatus = await runAutoResolveConflictSession({
    issueNumber,
    workspaceDir,
    abortSignal: stopSignal
  })
  record.conflictResolutionExitCode = resolveStatus.exitCode
  record.conflictResolutionSignal = resolveStatus.signal
  if (!hasSessionSucceeded(resolveStatus)) return false
  return watchCiAndFix(
    {
      issueNumber,
      branchName,
      workspaceDir,
      headShaBeforeSession,
      sessionName: '/auto-resolve-conflict',
      workStartedAt
    },
    record
  )
}
