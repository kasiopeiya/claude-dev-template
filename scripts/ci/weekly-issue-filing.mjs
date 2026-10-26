// 責務: 週次 Issue を起票する2本のスクリプト（code-policy-weekly-issue.mjs・doc-consistency-weekly-issue.mjs）に
//   共通の、gh による起票の手順と、本文に埋め込んでよいパスの条件をまとめる。
//   gh の癖への対処（検索 API の結果整合の遅れ・ラベル数の上限・引数長の上限）を1か所に集め、
//   片方のスクリプトにだけ修正が入る状態を防ぐ。

import { execFileSync } from 'child_process'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

import { BusinessError } from '../lib/errors.mjs'

// gh はどこから起動されても同じリポジトリを対象にするよう、このディレクトリを基準に実行する
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')

// GitHub の Issue 本文の上限文字数
export const GITHUB_ISSUE_BODY_MAX_LENGTH = 65536

// Issue 本文に埋め込んでよいパスの文字種。この本文は無人の Auto Programmer が指示として読むため、
// 改行や Markdown 記号を含むファイル名が紛れると、ファイル名という「データ」が
// タスク一覧に「命令」として混入する（プロンプトインジェクション）。埋め込む前に許可リストで弾く
const EMBEDDABLE_PATH_PATTERN = /^[\p{L}\p{N}._/@-]+$/u

/**
 * 指定のラベルが付いた open な Issue が既にあるかを返す。起票の直後の Issue も数える。
 *
 * @param {string} labelName ラベル名
 * @returns {boolean} あれば true
 */
export function hasOpenIssueWithLabel(labelName) {
  // gh issue list --label は検索 API 経由で、起票直後は結果整合の遅延で漏れるため issues 一覧（REST）を使う
  const openIssueCount = runGhCommand([
    'api',
    `repos/{owner}/{repo}/issues?labels=${labelName}&state=open`,
    '--jq',
    'map(select(.pull_request == null)) | length'
  ]).trim()
  return Number(openIssueCount) > 0
}

/**
 * ラベルが無ければ作る。
 *
 * @param {{ name: string, description: string, color: string }} label
 *   name: ラベル名 / description: ラベルの説明 / color: ラベルの色（16進6桁、先頭 `#` 無し）
 * @returns {void}
 */
export function ensureLabelExists({ name, description, color }) {
  // --limit で全件を取ってから探すと、ラベル数が上限を超えたリポジトリで既存ラベルを見落とし、
  // gh label create が「既にある」で失敗し続ける。--search で名前を絞ってから完全一致を見る
  // （名前に部分一致するラベルは少数なので、gh の既定の30件で足りる）
  const matchingLabelNames = runGhCommand([
    'label',
    'list',
    '--search',
    name,
    '--json',
    'name',
    '--jq',
    '.[].name'
  ])
  if (matchingLabelNames.split('\n').includes(name)) return
  runGhCommand(['label', 'create', name, '--description', description, '--color', color])
}

/**
 * ラベルが付いた Issue を、open・closed を問わず返す。
 *
 * @param {{ labelName: string, limit: number }} query ラベル名と、返す最大件数
 * @returns {{ number: number, body: string, createdAt: string }[]} Issue
 */
export function listIssuesWithLabel({ labelName, limit }) {
  return JSON.parse(
    runGhCommand([
      'issue',
      'list',
      '--label',
      labelName,
      '--state',
      'all',
      '--json',
      'number,body,createdAt',
      '--limit',
      String(limit)
    ])
  )
}

/**
 * Issue に付いたコメントを返す。
 *
 * @param {number} issueNumber Issue番号
 * @returns {{ authorAssociation: string, body: string }[]} コメント
 */
export function fetchIssueComments(issueNumber) {
  const { comments } = JSON.parse(
    runGhCommand(['issue', 'view', String(issueNumber), '--json', 'comments'])
  )
  return comments
}

/**
 * Issue を起票する。`labelNames` のラベルは事前に存在していること（無いと gh が失敗する。
 * `ensureLabelExists` で作っておく）。
 *
 * @param {{ title: string, labelNames: string[], body: string }} issue 起票する Issue
 * @returns {string} 起票した Issue の URL
 */
export function createIssue({ title, labelNames, body }) {
  return runGhCommand(
    ['issue', 'create', '--title', title, '--label', labelNames.join(','), '--body-file', '-'],
    body
  ).trim()
}

/**
 * パスがすべて Issue 本文に埋め込んでよい文字だけでできていることを確かめる。
 *
 * @param {string[]} paths Issue 本文に埋め込む予定のパス
 * @throws {BusinessError} 改行や Markdown 記号など、埋め込めない文字を含むパスがあるとき
 */
export function assertEmbeddablePaths(paths) {
  const unembeddablePaths = paths.filter((path) => !EMBEDDABLE_PATH_PATTERN.test(path))
  if (unembeddablePaths.length > 0) {
    throw new BusinessError(
      `Issue 本文に埋め込めないパスがある: ${JSON.stringify(unembeddablePaths)}`
    )
  }
}

/**
 * gh を実行して標準出力を返す。
 *
 * @param {string[]} args gh に渡す引数
 * @param {string} [input] 標準入力に渡す内容（`--body-file -` などで使う。巨大な引数を argv 経由にせず OS の引数長上限を避ける）
 * @returns {string} 標準出力
 */
function runGhCommand(args, input) {
  return execFileSync('gh', args, { cwd: repoRoot, encoding: 'utf8', input })
}
