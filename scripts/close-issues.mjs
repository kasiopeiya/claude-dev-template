#!/usr/bin/env node
// 責務: マージ済み PR の本文にある `Closes #N` を読み、まだ open な Issue を close する。
//   GITHUB_TOKEN でマージされた PR（pr-ai-triage.yml の auto-merge job）は `Closes #N` があっても
//   Issue を閉じないため、その後始末を人間が `npm run` で起動する。理由は docs/design/cicd-design.md「技術的制約」。
//
// 使い方:
//   npm run close-issues   close した Issue と、その根拠の PR を1件1行で標準出力に返す。
//                          close するものが無ければ、その旨を返す

import { execFileSync } from 'child_process'
import { realpathSync } from 'fs'
import { fileURLToPath } from 'url'

// 遡る PR の件数。close は何度走らせても結果が変わらないので、範囲を起点から計算せず直近の固定件数にする。
// 走らせる間隔のうちにこれを超えてマージされると、古い分を見落とす
const MERGED_PR_SCAN_LIMIT = 100

// GitHub が Issue を閉じるキーワード（close・fix・resolve の各活用形）。大文字小文字は区別しない。
// 別リポジトリの Issue（owner/repo#N）は対象外なので、`#` の直前は空白かコロンに限る
const CLOSING_KEYWORD_PATTERN =
  /(?<![\w-])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+#(\d+)(?!\d)/gi

function main() {
  const openIssueNumbers = listOpenIssueNumbers()
  const mergedPullRequests = listMergedPullRequests()

  const closeTargets = findIssuesToClose({ mergedPullRequests, openIssueNumbers })
  if (closeTargets.length === 0) {
    console.log(
      `close する Issue はありません（直近 ${mergedPullRequests.length} 件のマージ済み PR を確認）`
    )
    return
  }

  for (const { issueNumber, pullRequestNumber } of closeTargets) {
    closeIssue({ issueNumber, pullRequestNumber })
    console.log(`#${issueNumber} を close しました（PR #${pullRequestNumber}）`)
  }
}

/**
 * PR 本文から、GitHub が close の対象とみなす同じリポジトリの Issue 番号を取り出す。
 *
 * @param {string | null | undefined} body PR 本文
 * @returns {number[]} Issue 番号の一覧（重複なし、出てきた順）
 */
function extractClosingIssueNumbers(body) {
  const issueNumbers = [...(body ?? '').matchAll(CLOSING_KEYWORD_PATTERN)].map((match) =>
    Number(match[1])
  )
  return [...new Set(issueNumbers)]
}

/**
 * マージ済み PR の一覧から、close すべき open な Issue と、その根拠の PR を組にして返す。
 *
 * 同じ Issue を複数の PR が指すときは、一覧で先に出た PR を根拠にする。
 *
 * @param {{ mergedPullRequests: { number: number, body: string | null }[], openIssueNumbers: Set<number> }} params
 *   mergedPullRequests: マージ済み PR の一覧 / openIssueNumbers: open な Issue 番号の集合
 * @returns {{ issueNumber: number, pullRequestNumber: number }[]} close する Issue と根拠の PR
 */
function findIssuesToClose({ mergedPullRequests, openIssueNumbers }) {
  const candidatePairs = mergedPullRequests.flatMap(({ number: pullRequestNumber, body }) =>
    extractClosingIssueNumbers(body)
      .filter((issueNumber) => openIssueNumbers.has(issueNumber))
      .map((issueNumber) => ({ issueNumber, pullRequestNumber }))
  )

  const pullRequestNumberByIssueNumber = new Map()
  for (const { issueNumber, pullRequestNumber } of candidatePairs) {
    if (!pullRequestNumberByIssueNumber.has(issueNumber)) {
      pullRequestNumberByIssueNumber.set(issueNumber, pullRequestNumber)
    }
  }

  return [...pullRequestNumberByIssueNumber].map(([issueNumber, pullRequestNumber]) => ({
    issueNumber,
    pullRequestNumber
  }))
}

/**
 * open な Issue の番号を全件返す。
 *
 * @returns {Set<number>} open な Issue 番号の集合（PR は含まない）
 */
function listOpenIssueNumbers() {
  // issues 一覧（REST）は PR も返すので、pull_request を持つものを外す
  const output = runGhCommand([
    'api',
    '--paginate',
    'repos/{owner}/{repo}/issues?state=open&per_page=100',
    '--jq',
    '.[] | select(.pull_request == null) | .number'
  ])
  return new Set(
    output
      .split('\n')
      .filter((line) => line.length > 0)
      .map(Number)
  )
}

/**
 * 既定ブランチへマージされた直近の PR を返す。
 *
 * @returns {{ number: number, body: string | null }[]} マージ済み PR の一覧（新しい順）
 */
function listMergedPullRequests() {
  // GitHub が `Closes #N` で Issue を閉じるのは既定ブランチへのマージだけなので、それに揃える
  const defaultBranchName = runGhCommand([
    'repo',
    'view',
    '--json',
    'defaultBranchRef',
    '--jq',
    '.defaultBranchRef.name'
  ]).trim()
  const output = runGhCommand([
    'pr',
    'list',
    '--state',
    'merged',
    '--base',
    defaultBranchName,
    '--limit',
    String(MERGED_PR_SCAN_LIMIT),
    '--json',
    'number,body'
  ])
  return JSON.parse(output)
}

/**
 * Issue を完了として close し、根拠の PR をコメントに残す。
 *
 * @param {{ issueNumber: number, pullRequestNumber: number }} params close する Issue と根拠の PR
 * @returns {void}
 */
function closeIssue({ issueNumber, pullRequestNumber }) {
  runGhCommand([
    'issue',
    'close',
    String(issueNumber),
    '--reason',
    'completed',
    '--comment',
    `#${pullRequestNumber} がマージ済みなので close する（\`npm run close-issues\`）`
  ])
}

/**
 * gh を実行して標準出力を返す。
 *
 * @param {string[]} args gh に渡す引数
 * @returns {string} 標準出力
 */
function runGhCommand(args) {
  return execFileSync('gh', args, { encoding: 'utf8' })
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
