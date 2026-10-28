// 責務: Issue 1件を終えた結果を、画面の締めと読み上げが共有する4つの分類に決める純粋関数だけを担う。
//
// 設計意図（WHY）:
// - 画面（✗・⚠・✓）と読み上げは、同じ分類を見る。別々に判定すると、片方だけ直したときに画面と耳で
//   人間の手当てが要るかが食い違う（Issue #780）。
// - I/O を持たない層をここに切り出すことで、GitHub にも画面にも触れずに確かめられる。

import { isSubIssueHandoverEmpty, shouldMarkAsNeedsHumanCheck } from './needsHumanCheck.mjs'

/**
 * Issue 1件の締めの結果を分類する。上から当てて、最初に当たったものを返す。
 *
 * 実装が失敗しても例外は出ない（セッションが 0 以外で終わるだけ）ので、例外の有無だけでなく「人間の手当てが要るか」でも決める。
 *
 * @param {{ error?: string, reasonNotToImplement?: string | null, subIssueHandover?: { putOnReadySubIssueNumbers: number[] }, isSkippedByIssueCheckVerdict?: boolean, isCiPassed?: boolean, isClosedWithoutChanges?: boolean }} record 記録した内容
 * @param {boolean} isAllSessionsSucceeded 走らせた claude セッションがすべて正常終了したか
 * @returns {'failed' | 'needs-human-attention' | 'handed-over-to-sub-issues' | 'completed'} 処理中に例外で落ちた（failed）・人間の手当てが要る（needs-human-attention）・子 Issue を1件以上着手待ちに載せた（handed-over-to-sub-issues）・それ以外の成功（completed）
 */
export function decideRunOutcome(record, isAllSessionsSucceeded) {
  if (record.error) return 'failed'
  // /issue-check の判定で止めた Issue は予定した終わり方だが、人間判断・close を見てほしいので手当てが要る側に入れる
  if (
    Boolean(record.reasonNotToImplement) ||
    shouldMarkAsNeedsHumanCheck(record, isAllSessionsSucceeded)
  ) {
    return 'needs-human-attention'
  }
  if (record.subIssueHandover && !isSubIssueHandoverEmpty(record))
    return 'handed-over-to-sub-issues'
  return 'completed'
}
