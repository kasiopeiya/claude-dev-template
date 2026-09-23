// 責務: /issue-check を通した後の Issue の状態から、実装へ進むか止めるかを決める純粋関数だけを担う。
//
// 設計意図（WHY）:
// - 判定は /issue-check が GitHub へ書き戻したラベルと state だけで行い、AI の出力を解釈しない。
//   同じ Issue の状態なら必ず同じ結論になる。
// - `issue:checked` は判定が何であれ貼られるので、判定の中身の分岐には使わない。使うのは「今回の判定が
//   書き戻されたか」の印としてだけで、呼び出し側が監査の前に外しておく。終了コード 0 は書き戻しを
//   保証しない（/issue-check は判定を読めないとき、何も書き戻さずに終わる）。
// - 判定の中身で止めるのは「人間判断」と「不要（close）」だけで、「方針差し替え」は本文が直って
//   ai-fixable のまま残るので止めない。
// - ラベル名は `.claude/skills/issue-check/SKILL.md` が貼る表記が正。
// - I/O を持たない層をここに切り出すことで、GitHub に触れずに単体テストできる。

export const ISSUE_CHECKED_LABEL = 'issue:checked'
const NEEDS_HUMAN_DECISION_LABEL = 'issue:needs-human-decision'

/**
 * 監査後の Issue を実装へ進めてはいけない理由を返す。
 *
 * @param {{ state: string, labelNames: string[] }} issue 監査の前に `issue:checked` を外し、監査後に引き直した Issue（state は gh の表記で 'OPEN' / 'CLOSED'）
 * @returns {string | null} 止める理由（実装へ進めてよければ null）
 */
export function findReasonToSkipImplementation({ state, labelNames }) {
  if (state !== 'OPEN') return '/issue-check が不要と判定して close しました'
  if (!labelNames.includes(ISSUE_CHECKED_LABEL)) return '/issue-check が判定を書き戻しませんでした'
  if (labelNames.includes(NEEDS_HUMAN_DECISION_LABEL)) {
    return `/issue-check が人間の判断を要すると判定しました（${NEEDS_HUMAN_DECISION_LABEL}）`
  }
  return null
}
