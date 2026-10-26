// 責務: /issue-check を通した後の Issue の状態から、実装へ進むか止めるかを決める純粋関数だけを担う。
//
// 設計意図（WHY）:
// - 判定は /issue-check が GitHub へ書き戻したラベルと state だけで行い、AI の出力を解釈しない。
//   同じ Issue の状態なら必ず同じ結論になる。
// - `issue:checked` は判定が何であれ貼られるので、判定の中身の分岐には使わない。使うのは「今回の判定が
//   書き戻されたか」の印としてだけで、呼び出し側はこのラベルが無い Issue にだけ監査を走らせる。
//   終了コード 0 は書き戻しを保証しない（/issue-check は判定を読めないとき、何も書き戻さずに終わる）。
// - 判定の中身で止めるのは「人間判断」「人間しかできない作業」「不要（close）」だけで、「方針差し替え」は
//   本文が直って ai-fixable のまま残るので止めない。
// - 対象ラベル（ai-fixable）が外れた Issue も止める。/issue-check がラベルを付け替えると対象ラベルが外れるので、
//   止める理由のラベルを1つずつ並べるだけでは、ラベルが増えたときに取りこぼす。
// - ラベル名は `.claude/skills/issue-check/SKILL.md` が貼る表記が正。
// - 対話の「issue N 対応して」も、CLAUDE.md「issue番号だけで開発フローを自動追従する」に同じ止める条件を
//   文章で持つ。条件を変えるときは両方を直す。
// - I/O を持たない層をここに切り出すことで、GitHub に触れずに確かめられる。

export const ISSUE_CHECKED_LABEL = 'issue:checked'
// 人間が方針を決める・人間が作業する Issue に付くラベルと、実装を止めるときに記録へ残す判定の言い回し。
// 子を着手待ちに載せるかの判定も HUMAN_ONLY_LABELS を使い、人間向けのラベルが増えたときに片方だけ直る食い違いを防ぐ
const HUMAN_ONLY_LABEL_TO_VERDICT_PHRASE = new Map([
  ['needs-human-decision', '人間の判断を要する'],
  ['ready-for-human', '人間しかできない作業だ']
])
export const HUMAN_ONLY_LABELS = [...HUMAN_ONLY_LABEL_TO_VERDICT_PHRASE.keys()]

/**
 * 監査後の Issue を実装へ進めてはいけない理由を返す。
 *
 * @param {{ state: string, labelNames: string[] }} issue 監査後（監査済みで飛ばしたときはその時点）に引き直した Issue（state は gh の表記で 'OPEN' / 'CLOSED'）
 * @param {string} targetIssueLabel 実装へ進めてよい Issue に付く対象ラベル（config.mjs の targetIssueLabel）
 * @returns {{ reason: string, isVerdict: boolean } | null} 止める理由と、それが /issue-check の判定そのものか（判定が書き戻されていなければ false）。実装へ進めてよければ null
 */
export function findSkipImplementationDecision({ state, labelNames }, targetIssueLabel) {
  if (state !== 'OPEN') {
    return { reason: '/issue-check が不要と判定して close しました', isVerdict: true }
  }
  if (!labelNames.includes(ISSUE_CHECKED_LABEL)) {
    return { reason: '/issue-check が判定を書き戻しませんでした', isVerdict: false }
  }
  for (const [humanOnlyLabel, verdictPhrase] of HUMAN_ONLY_LABEL_TO_VERDICT_PHRASE) {
    if (labelNames.includes(humanOnlyLabel)) {
      return {
        reason: `/issue-check が${verdictPhrase}と判定しました（${humanOnlyLabel}）`,
        isVerdict: true
      }
    }
  }
  if (!labelNames.includes(targetIssueLabel)) {
    return { reason: `/issue-check が ${targetIssueLabel} を外しました`, isVerdict: true }
  }
  return null
}
