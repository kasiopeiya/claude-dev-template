// 責務: push の後、CI を待つ前に、待っても意味が無い理由（と、それが予定した終わり方か）を決める純粋関数だけを担う。
//
// 設計意図（WHY）:
// - リモートのブランチが無く Issue が CLOSED という入力は、差分が出ない Issue を /auto-dev が閉じたときと、PR が
//   マージされてブランチが消えたときの両方で起きる。マージ済みの PR を見分けないと、PR を出した Issue を
//   「差分が出ない」と記録し、CI が通ったかを記録から読めなくなる（Issue #1120）。
// - 今回の作業の PR かは、作業を始めた後にマージされたかで見分ける。ブランチ名は Issue ごとに同じなので、
//   再オープンされた Issue の前回の PR も同じ名前でマージ済みと出る。
// - マージは必須チェックの CI が通らないと起きないので、マージ済みは CI が通った終わり方に数える。
// - I/O を持たない層をここに切り出すことで、GitHub に触れずに確かめられる。

import { NEEDS_HUMAN_CHECK_LABEL } from './needsHumanCheck.mjs'

/**
 * CI を待つ前に、待っても意味が無い理由を探す。
 *
 * @param {{ state: string, labelNames: string[], remoteHeadSha: string, localHeadSha: string, previousHeadSha: string | null, lastSessionName: string, mergedPullRequest: { number: number, mergedAt: string } | null, workStartedAt: string }} params 対象 Issue の state（'OPEN' / 'CLOSED'）とラベル名・リモートのブランチの SHA（push されていなければ空文字）・clone の HEAD の SHA・push されなかったとみなす SHA（前回 CI を待った SHA。衝突を解かせた直後はセッション前の SHA。新しく作ったブランチの最初の確認では null）・直前に走らせたセッションの名前・ブランチを head とするマージ済みの PR の番号とマージ時刻（ISO 8601。無ければ null）・今回の作業を始めた時刻（ISO 8601。これより前にマージされた PR は今回の作業の PR ではない）
 * @returns {{ ciOutcome: string, isCiPassed: boolean, isClosedWithoutChanges: boolean } | null} 記録にそのまま書く、待たない理由と、それが CI の通った終わり方（PR のマージ）か・差分の出ない Issue を /auto-dev が閉じた（予定した終わり方）ためか。待ってよければ null
 */
export function findDecisionNotToWaitForCi({
  state,
  labelNames,
  remoteHeadSha,
  localHeadSha,
  previousHeadSha,
  lastSessionName,
  mergedPullRequest,
  workStartedAt
}) {
  // /auto-dev の起動前に外し、付いた Issue の衝突は解かせないので、付いていれば今回のセッションが離脱した印
  // GitHub のラベル名は大文字小文字を区別しない
  if (
    labelNames.some(
      (labelName) => labelName.toLowerCase() === NEEDS_HUMAN_CHECK_LABEL.toLowerCase()
    )
  ) {
    return buildUnplannedDecision(`${NEEDS_HUMAN_CHECK_LABEL} が付いているので CI を待ちません`)
  }
  // Issue が OPEN なら、マージ済みの PR があっても今回の作業の PR ではない（再オープンされた Issue の古い PR など）
  const isMergedDuringThisWork =
    mergedPullRequest !== null &&
    Date.parse(mergedPullRequest.mergedAt) >= Date.parse(workStartedAt)
  if (!remoteHeadSha && state !== 'OPEN' && isMergedDuringThisWork) {
    return {
      ciOutcome: `PR #${mergedPullRequest.number} がマージ済みです`,
      isCiPassed: true,
      isClosedWithoutChanges: false
    }
  }
  if (!remoteHeadSha && state !== 'OPEN') {
    return {
      ciOutcome: '差分が出ないので /auto-dev が Issue を閉じました',
      isCiPassed: false,
      isClosedWithoutChanges: true
    }
  }
  if (!remoteHeadSha)
    return buildUnplannedDecision('ブランチが push されていないので CI を待ちません')
  if (remoteHeadSha === previousHeadSha) {
    return buildUnplannedDecision(`${lastSessionName} が push しませんでした`)
  }
  // 待った SHA は記録に残り、衝突を解かせてよいかを決める「このツールの commit」の目印になる。clone の HEAD と違う
  // リモートの commit は、このツール以外の push なので、待たずに人間へ回す
  if (remoteHeadSha !== localHeadSha) {
    return buildUnplannedDecision(
      'リモートのブランチに、このツール以外の push があるので CI を待ちません'
    )
  }
  return null
}

/**
 * 予定した終わり方ではない（人間の手当てが要る）待たない理由を作る。
 *
 * @param {string} ciOutcome 待たない理由
 * @returns {{ ciOutcome: string, isCiPassed: false, isClosedWithoutChanges: false }} 記録にそのまま書く、待たない理由
 */
function buildUnplannedDecision(ciOutcome) {
  return { ciOutcome, isCiPassed: false, isClosedWithoutChanges: false }
}
