// 責務: open な sub-issue を持つ Issue を子へ引き継ぐか、引き継ぐならどの子をボードの着手待ちに載せるかを決める純粋関数だけを担う。
//
// 設計意図（WHY）:
// - open な sub-issue を持つ Issue は、監査も実装もしない。umbrella（子への入口）になった親を実装すると、
//   子と作業が二重になる。代わりに子を着手待ちに載せ、自分を担当者にして拾わせる。
// - 担当者は「無い」だけでなく「自分だけ」の子も載せる。`/to-issues` などが起票と同時に自分を担当者にするので、
//   「無い」に絞ると子が1件も載らない。自分以外の担当者がいる子は、取り合わないよう外す（Issue #683）。
// - 判断待ちの子は、「着手してよい」を意味する着手待ちに置かない。カードを動かすのは、ボードに無いか、着手前の
//   Status にある子だけにする。着手した後（着手中・レビュー待ち・完了）の子を着手待ちへ戻すと、同じ Issue を
//   もう一度拾う。着手前の Status を並べるのは、ボードに Status が増えても既定で動かさない側に倒すため。
// - 対象リポジトリの外の子は載せない。候補は対象リポジトリの Issue に限るので、載せても拾われない。
// - I/O を持たない層をここに切り出すことで、GitHub に触れずに単体テストできる。

/**
 * open な sub-issue を持つ Issue を、監査も実装もしてはいけない理由を返す。
 *
 * @param {{ state: string }[]} subIssues Issue の sub-issue（state は gh の表記で 'OPEN' / 'CLOSED'）
 * @returns {string | null} 止める理由（open な sub-issue が無ければ null）
 */
export function findReasonToSkipForOpenSubIssues(subIssues) {
  const openSubIssueCount = subIssues.filter(({ state }) => state === 'OPEN').length
  if (openSubIssueCount === 0) return null
  return `open な sub-issue を ${openSubIssueCount} 件持ちます`
}

/**
 * sub-issue のうち、ボードの着手待ちに載せて担当者を自分にする子を選ぶ。
 *
 * @template {{ repository: string, state: string, labelNames: string[], assigneeLogins: string[], boardStatusName: string | null }} SubIssue
 * @param {SubIssue[]} subIssues Issue の sub-issue（state は gh の表記で 'OPEN' / 'CLOSED'。boardStatusName はボードに無ければ null）
 * @param {{ repository: string, viewerLogin: string, targetIssueLabel: string, needsHumanDecisionLabel: string, notStartedStatusNames: string[] }} criteria
 *   対象リポジトリ（owner/repo）・自分のログイン名・対象ラベル・人間判断待ちのラベル・着手前を表す Status の表記
 * @returns {SubIssue[]} 対象リポジトリにあり、担当者が無いか自分だけで、対象ラベル付き・人間判断待ちでなく、ボードに無いか着手前の Status にある open な子
 */
export function selectSubIssuesToPutOnReady(
  subIssues,
  { repository, viewerLogin, targetIssueLabel, needsHumanDecisionLabel, notStartedStatusNames }
) {
  return subIssues.filter(
    (subIssue) =>
      subIssue.state === 'OPEN' &&
      subIssue.repository === repository &&
      subIssue.assigneeLogins.every((login) => login === viewerLogin) &&
      subIssue.labelNames.includes(targetIssueLabel) &&
      !subIssue.labelNames.includes(needsHumanDecisionLabel) &&
      (subIssue.boardStatusName === null ||
        notStartedStatusNames.includes(subIssue.boardStatusName))
  )
}
