// 責務: /issue-check を通した後の Issue の状態から、実装へ進むか止めるかを決める純粋関数だけを担う。
//
// 設計意図（WHY）:
// - 判定は /issue-check が GitHub へ書き戻したラベルと state だけで行い、AI の出力を解釈しない。
//   同じ Issue の状態なら必ず同じ結論になる。
// - `issue:checked` は判定が何であれ貼られるので、判定の中身の分岐には使わない。使うのは「今回の判定が
//   書き戻されたか」の印としてだけで、呼び出し側はこのラベルが無い Issue にだけ監査を走らせる。
//   終了コード 0 は書き戻しを保証しない（/issue-check は判定を読めないとき、何も書き戻さずに終わる）。
// - 週次ラベルの Issue は監査を走らせず、`issue:checked` が無くても止めない。本文に変更対象が無く、見積もりが
//   0 行になるので、監査しても判定は変わらない（Issue #1231・#1543）。
// - 判定の中身で止めるのは「人間判断」「人間しかできない作業」「不要（close）」だけで、「方針差し替え」は
//   本文が直って ai-fixable のまま残るので止めない。
// - 対象ラベル（ai-fixable）が外れた Issue も止める。/issue-check がラベルを付け替えると対象ラベルが外れるので、
//   止める理由のラベルを1つずつ並べるだけでは、ラベルが増えたときに取りこぼす。
// - ラベル名は `.claude/skills/issue-check/SKILL.md` が貼る表記が正。
// - 書き戻しの確認だけを外す指定（isWritebackCheckSkipped）は、人間が監査を飛ばして急ぐ経路（`/asap`）のためにある。
//   監査を打たないので `issue:checked` が無いのは正常で、そこで止めると急げない。人間向けのラベルと対象ラベルの
//   確認は外さない（止めるべき Issue に着手しないことは速さより優先する）。Auto Programmer は指定しない。
// - 対話の「issue N 対応して」の経路は、scripts/decide-issue-start.mjs がこのファイルの関数を呼ぶ。
// - I/O を持たない層をここに切り出すことで、GitHub に触れずに確かめられる。

export const ISSUE_CHECKED_LABEL = 'issue:checked'
// 週次ワークフローが起票した Issue に付くラベル。表記は docs/policy/issue-policy.md の週次ラベルの行が正
const WEEKLY_ISSUE_LABELS = ['doc-audit-weekly', 'code-policy-weekly']
// 人間が方針を決める・人間が作業する Issue に付くラベルと、実装を止めるときに記録へ残す判定の言い回し。
// 子を着手待ちに載せるかの判定も HUMAN_ONLY_LABELS を使い、人間向けのラベルが増えたときに片方だけ直る食い違いを防ぐ
const HUMAN_ONLY_LABEL_TO_VERDICT_PHRASE = new Map([
  ['needs-human-decision', '人間の判断を要する'],
  ['ready-for-human', '人間しかできない作業だ']
])
export const HUMAN_ONLY_LABELS = [...HUMAN_ONLY_LABEL_TO_VERDICT_PHRASE.keys()]

/**
 * 実装の前に `/issue-check` を起動するかを返す。`issue:checked` が付いた Issue と、週次ラベルの Issue は起動しない。
 *
 * @param {string[]} labelNames Issue に付いているラベルの名前
 * @returns {boolean} 起動するなら true
 */
export function shouldRunIssueCheck(labelNames) {
  const hasWeeklyIssueLabel = WEEKLY_ISSUE_LABELS.some((weeklyIssueLabel) =>
    labelNames.includes(weeklyIssueLabel)
  )
  return !labelNames.includes(ISSUE_CHECKED_LABEL) && !hasWeeklyIssueLabel
}

/**
 * 監査後の Issue を実装へ進めてはいけない理由を返す。
 *
 * @param {{ state: string, labelNames: string[] }} issue 監査後（監査済みで飛ばしたときはその時点）に引き直した Issue（state は gh の表記で 'OPEN' / 'CLOSED'）
 * @param {string} targetIssueLabel 実装へ進めてよい Issue に付く対象ラベル（config.mjs の targetIssueLabel）
 * @param {{ isWritebackCheckSkipped?: boolean }} [options] `isWritebackCheckSkipped` が true なら、判定が書き戻されたかの確認だけを外す（人間が監査を飛ばして急ぐときの指定。既定は false）。人間向けのラベル・対象ラベルの確認は外さない
 * @returns {{ reason: string, isVerdict: boolean } | null} 止める理由と、それが /issue-check の判定そのものか（判定が書き戻されていなければ false）。実装へ進めてよければ null
 */
export function findSkipImplementationDecision(
  { state, labelNames },
  targetIssueLabel,
  { isWritebackCheckSkipped = false } = {}
) {
  if (state !== 'OPEN') {
    return { reason: '/issue-check が不要と判定して close しました', isVerdict: true }
  }
  // 監査を走らせる条件が監査後も残っている＝判定が書き戻されていない
  if (!isWritebackCheckSkipped && shouldRunIssueCheck(labelNames)) {
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
