// 責務: close した Issue のうち、作業 Issue に数えないものとその理由を決めることだけを担う。
//
// 設計意図（WHY）:
// - 定義をここに1つだけ置く。作業 Issue を数えるスクリプトが定義を写して持つと、片方だけ直したときに「完了した作業」の数が食い違う。
//   `scripts/perf-report.mjs` に置かないのは、集計のスクリプトに定義の置き場の役まで持たせないためである。
// - 規則の配列は export せず、判定の関数と、規則が読む項目のクエリ断片を export する。
//   配列を渡すと、当て方（最初に当たった規則だけで数える）と引く項目を、使う側が守らなければならなくなる。
//   項目を引き忘れると、例外を出さずに数が変わる（stateReason が無いと全件が notCompleted になる）。
// - 親かどうかは subIssues の有無で決める。`tracking-issue` は第2階層の親にしか付かない（#1587）。
// - レビュー通知は bot 名義に限る。`needs-human-review` は PR のラベルで、作業でないのは bot が起票する通知の Issue だけである。
// - ラベルも本文も無い Issue はメモとして除く。#835 の子に資料の見出しだけを書いたものがあり（#939 など）、何の作業かを確かめられない。

export const HUMAN_REVIEW_LABEL = 'needs-human-review'
const ROOT_ISSUE_LABEL = 'phase'
const WEEKLY_ISSUE_LABELS = ['doc-audit-weekly', 'code-policy-weekly']

/**
 * 判定が読む Issue の項目。GraphQL の `... on Issue { }` の中に埋め込む。
 * 項目を足すときは、下の `ExclusionTarget` も同じに直す。使う側がほかの判定にも同じ項目を読むことがあるので（`scripts/perf-report.mjs` の委譲の分類は labels を読む）、項目を外すときは使う側のクエリに移す。
 */
export const EXCLUSION_TARGET_FIELDS = `stateReason
body
author { __typename }
labels(first: 50) { nodes { name } }
subIssues { totalCount }`

/**
 * 判定が読む Issue の項目（`EXCLUSION_TARGET_FIELDS` で引いた形）。
 *
 * @typedef {object} ExclusionTarget
 * @property {string | null} stateReason close の理由（COMPLETED・NOT_PLANNED・DUPLICATE）
 * @property {string} body 本文
 * @property {{ __typename: string } | null} author 起票者（アカウントが消えていれば null）
 * @property {{ nodes: { name: string }[] }} labels ラベル
 * @property {{ totalCount: number }} subIssues 子 Issue
 */

/** @type {{ reason: string, matches: (issue: ExclusionTarget) => boolean }[]} */
const EXCLUSION_RULES = [
  { reason: 'notCompleted', matches: (issue) => issue.stateReason !== 'COMPLETED' },
  {
    reason: 'reviewNotification',
    matches: (issue) => issue.author?.__typename === 'Bot' && hasLabel(issue, [HUMAN_REVIEW_LABEL])
  },
  { reason: 'parent', matches: (issue) => issue.subIssues.totalCount > 0 },
  { reason: 'rootIssue', matches: (issue) => hasLabel(issue, [ROOT_ISSUE_LABEL]) },
  { reason: 'weeklyIssue', matches: (issue) => hasLabel(issue, WEEKLY_ISSUE_LABELS) },
  {
    reason: 'memo',
    matches: (issue) => issue.labels.nodes.length === 0 && issue.body.trim() === ''
  }
]

/** 除外の理由を、判定で当てる順に並べたもの。理由ごとの件数の表のキーに使う。 */
export const EXCLUSION_REASONS = EXCLUSION_RULES.map(({ reason }) => reason)

/**
 * 1件の Issue を、作業 Issue に数えるかを決める。理由は1件に1つだけ返すので、理由ごとの件数を足すと除外した総数に一致する。
 *
 * @param {ExclusionTarget} issue close した Issue
 * @returns {string | null} 数えないなら除外の理由（`EXCLUSION_REASONS` のどれか）。作業 Issue なら null
 */
export function findExclusionReason(issue) {
  return EXCLUSION_RULES.find(({ matches }) => matches(issue))?.reason ?? null
}

/**
 * @param {ExclusionTarget} issue 調べる Issue
 * @param {string[]} labelNames 探すラベルの名前
 * @returns {boolean} どれか1つでも付いていれば true
 */
function hasLabel(issue, labelNames) {
  return issue.labels.nodes.some(({ name }) => labelNames.includes(name))
}
