// 責務: Issue 1件を終えた結果から、その Issue に `needs-human-check`（無人実行が問題で止まり、人間に確かめてほしい印）を
//   付けるかを決める純粋関数だけを担う。
//
// 設計意図（WHY）:
// - 予定した終わり方だけを並べ、それ以外はすべて付ける。止まり方を1つずつ数えて付けると、止まり方が増えるたびに
//   付け漏れ、人間がこのラベル1つで止まった Issue を引けなくなる（Issue #1000）。
// - 予定した終わり方と付ける条件は docs/policy/issue-policy.md が正。ラベル名は /auto-dev・/auto-fix-ci・/auto-resolve-conflict の
//   SKILL.md（離脱手順）の表記と一字一句合わせる。
// - I/O を持たない層をここに切り出すことで、GitHub に触れずに単体テストできる。

export const NEEDS_HUMAN_CHECK_LABEL = 'needs-human-check'

/**
 * 子へ引き継ごうとして、1件も着手待ちに載せられなかったか。
 *
 * 親は着手中に残るので、子も進んでいなければ、人間が見るまで誰も進めない。
 *
 * @param {{ subIssueHandover?: { putOnReadySubIssueNumbers: number[] } }} record 記録した内容
 * @returns {boolean} 子へ引き継いだうえで、載せた子が0件なら true
 */
export function isSubIssueHandoverEmpty(record) {
  return record.subIssueHandover?.putOnReadySubIssueNumbers.length === 0
}

/**
 * Issue 1件を終えた結果から、`needs-human-check` を付けるかを決める。
 *
 * 予定した終わり方は、CI が通った・差分が出ない Issue を /auto-dev が閉じた・/issue-check の判定で止めた・
 * 子を1件以上着手待ちに載せた、の4つ。どれか1つに当たれば付けない（判定で止めつつ子を載せた、のように
 * 重なっても、載せた子か判定の印が人間への渡し方を担う）。ただし処理中の例外とセッションの失敗は、当たっていても付ける。
 *
 * @param {{ error?: string, subIssueHandover?: { putOnReadySubIssueNumbers: number[] }, isSkippedByIssueCheckVerdict?: boolean, isCiPassed?: boolean, isClosedWithoutChanges?: boolean }} record 記録した内容
 * @param {boolean} isAllSessionsSucceeded 走らせた claude セッションがすべて正常終了したか
 * @returns {boolean} 予定した終わり方以外で終えたなら true
 */
export function shouldMarkAsNeedsHumanCheck(record, isAllSessionsSucceeded) {
  if (record.error || !isAllSessionsSucceeded) return true
  const hasHandedOverToSubIssues =
    Boolean(record.subIssueHandover) && !isSubIssueHandoverEmpty(record)
  const hasEndedAsPlanned =
    Boolean(record.isCiPassed) ||
    Boolean(record.isClosedWithoutChanges) ||
    Boolean(record.isSkippedByIssueCheckVerdict) ||
    hasHandedOverToSubIssues
  return !hasEndedAsPlanned
}
