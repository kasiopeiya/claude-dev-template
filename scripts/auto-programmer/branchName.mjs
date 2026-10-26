// 責務: Issue のラベルと番号、設定の接頭辞からトピックブランチ名を決める純粋関数（接頭辞の検査を含む）だけを担う。
//
// 設計意図（WHY）:
// - I/O を持たない層をここに切り出すことで、GitHub にも clone にも触れずに確かめられる。
// - 種類（feat・fix など）の語彙は .claude/skills/git-commit/SKILL.md「ブランチ命名規則」が正。pipeline.yml の
//   push トリガもこの7つだけを受けるため、ここに無い種類を作ると CI が1つも走らない PR ができる。
// - 種類の前に付ける接頭辞（config.mjs の branchPrefix。例 st2）は、ライン（main・main2 など）ごとに CI を
//   分けている利用先のためにある。付けたら、その利用先の CI の push トリガにも同じ接頭辞を足さないと CI が走らない。
// - 接頭辞は1段だけ、英数字・_・- だけを許す。要るのは st2 のような1語だけで、git のブランチ名の規則を全部写さずに
//   確実に正しい名前だけを通すためである。

import { TechnicalError } from '../lib/errors.mjs'

// 「変更の種類」ラベル → ブランチの種類。種類ラベルが複数付いた Issue でも1つに決まるよう、上にあるものから先に当てる
const TYPE_LABEL_TO_BRANCH_TYPE = [
  ['feature', 'feat'],
  ['bug', 'fix'],
  ['cicd', 'ci'],
  ['refactor', 'refactor'],
  ['docs', 'docs'],
  ['chore', 'chore']
]

// 種類ラベルが1つも付いていない Issue の逃がし先。種類ラベルは PR に付けるもので Issue にはまず無く、
// 飛ばすとほぼ全件が止まる。種類が効くのは CI が走るかだけで、PR の種類ラベルは CI が付け直す
const DEFAULT_BRANCH_TYPE = 'chore'

// 先頭の - は git がブランチ名として受け付けないので、先頭だけ英数字と _ に限る
const BRANCH_PREFIX_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/

/**
 * ブランチ名の前に付ける接頭辞が、付けない（undefined・空文字）か、英数字・`_`・`-` だけの1語（先頭は `-` 以外）で
 * あることを確かめる。
 *
 * @param {unknown} branchPrefix config.mjs の `branchPrefix`
 * @returns {void}
 * @throws {TechnicalError} 接頭辞が文字列でない、英数字・`_`・`-` 以外の文字（`/`・`.`・空白など）を含む、または先頭が `-` のとき
 */
export function validateBranchPrefix(branchPrefix) {
  if (branchPrefix === undefined || branchPrefix === '') return
  if (typeof branchPrefix === 'string' && BRANCH_PREFIX_PATTERN.test(branchPrefix)) return
  // JSON.stringify で引用符付きにし、末尾の空白や改行が紛れた値でも原因の文字が見えるようにする
  throw new TechnicalError(
    `scripts/auto-programmer/config.mjs の branchPrefix は、英数字・_・- だけの1語（先頭は英数字か _）か、空文字で指定してください（いまの値: ${JSON.stringify(branchPrefix)}）。ブランチ名の前に付ける接頭辞です`
  )
}

/**
 * Issue 1件に対応するトピックブランチ名を組み立てる。
 *
 * Issue タイトルは名前に入れない。同じ Issue を何度処理しても同じ名前になり、
 * タイトルを編集してもブランチが増えないようにするためである。
 *
 * @param {{ issueNumber: number, labelNames: string[], branchPrefix: string | undefined }} branchNameSource 対象 Issue の
 *   番号とラベル名と、config.mjs の接頭辞（undefined・空文字なら付けない）
 * @returns {string} `<種類>/issue-<番号>` 形式のブランチ名（接頭辞があれば `<接頭辞>/<種類>/issue-<番号>`）
 * @throws {TypeError} issueNumber が正の整数でないとき
 * @throws {TechnicalError} branchPrefix が正しい接頭辞でないとき
 */
export function buildBranchName({ issueNumber, labelNames, branchPrefix }) {
  validateBranchPrefix(branchPrefix)
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new TypeError(`Issue 番号が正の整数ではありません: ${issueNumber}`)
  }
  const branchNameWithoutPrefix = `${selectBranchType(labelNames)}/issue-${issueNumber}`
  return branchPrefix ? `${branchPrefix}/${branchNameWithoutPrefix}` : branchNameWithoutPrefix
}

/**
 * ラベル名の一覧からブランチの種類を選ぶ。
 *
 * 種類ラベルが複数あるときは、表の並び順で先に当たったものを使う。1つも無ければ 'chore' を返す。
 *
 * @param {string[]} labelNames Issue に付いているラベル名（種類ラベル以外を含んでよい）
 * @returns {string} ブランチの種類（git-commit Skill のブランチ命名規則にある7種類のいずれか）
 */
function selectBranchType(labelNames) {
  const labelNameSet = new Set(labelNames)
  const matched = TYPE_LABEL_TO_BRANCH_TYPE.find(([label]) => labelNameSet.has(label))
  return matched ? matched[1] : DEFAULT_BRANCH_TYPE
}
