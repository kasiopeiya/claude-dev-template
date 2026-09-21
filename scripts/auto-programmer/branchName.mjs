// 責務: Issue のラベルと番号からトピックブランチ名を決める純粋関数だけを担う。
//
// 設計意図（WHY）:
// - I/O を持たない層をここに切り出すことで、GitHub にも clone にも触れずに単体テストできる。
// - prefix の語彙は docs/policy/git-policy.md「ブランチ命名規則」が正。pipeline.yml の push
//   トリガもこの7つだけを受けるため、ここに無い prefix を作ると CI が1つも走らない PR ができる。
// - 種類ラベルが複数付いた Issue でも1つに決まるよう、表の並び順を優先順位そのものにしている。

// 「変更の種類」ラベル → ブランチ prefix。上にあるものから先に当てる
const TYPE_LABEL_TO_BRANCH_PREFIX = [
  ['feature', 'feat'],
  ['bug', 'fix'],
  ['cicd', 'ci'],
  ['refactor', 'refactor'],
  ['docs', 'docs'],
  ['chore', 'chore']
]

// 種類ラベルが1つも付いていない Issue の逃がし先。種類ラベルは PR に付けるもので Issue にはまず無く、
// 飛ばすとほぼ全件が止まる。prefix が効くのは CI が走るかだけで、PR の種類ラベルは CI が付け直す
const DEFAULT_BRANCH_PREFIX = 'chore'

/**
 * ラベル名の一覧からブランチ prefix を選ぶ。
 *
 * 種類ラベルが複数あるときは、表の並び順で先に当たったものを使う。1つも無ければ 'chore' を返す。
 *
 * @param {string[]} labelNames Issue に付いているラベル名（種類ラベル以外を含んでよい）
 * @returns {string} ブランチ prefix（git-policy の7プレフィックスのいずれか）
 */
function selectBranchPrefix(labelNames) {
  const names = new Set(Array.isArray(labelNames) ? labelNames : [])
  const matched = TYPE_LABEL_TO_BRANCH_PREFIX.find(([label]) => names.has(label))
  return matched ? matched[1] : DEFAULT_BRANCH_PREFIX
}

/**
 * Issue 1件に対応するトピックブランチ名を組み立てる。
 *
 * Issue タイトルは名前に入れない。同じ Issue を何度処理しても同じ名前になり、
 * タイトルを編集してもブランチが増えないようにするためである。
 *
 * @param {{ issueNumber: number, labelNames: string[] }} issue 対象 Issue の番号とラベル名
 * @returns {string} `<prefix>/issue-<番号>` 形式のブランチ名
 * @throws {TypeError} issueNumber が正の整数でないとき
 */
export function buildBranchName({ issueNumber, labelNames }) {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new TypeError(`Issue 番号が正の整数ではありません: ${issueNumber}`)
  }
  return `${selectBranchPrefix(labelNames)}/issue-${issueNumber}`
}
