#!/usr/bin/env node
// 責務: マージ済み PR の本文にある `Closes #N` を読み、まだ open な Issue を close する。
//   GITHUB_TOKEN でマージされた PR（pr-ai-triage.yml の auto-merge job）は `Closes #N` があっても
//   Issue を閉じないため、その後始末をする。理由は docs/design/cicd-design.md「技術的制約」。
//
// 設計意図（WHY）:
// - 読む PR は、同じリポジトリのブランチから出て、作者がいま Issue を閉じられる権限を持つもの（bot か、
//   OWNER・MEMBER・COLLABORATOR）だけにする。作者は PR 本文をマージ後も書き換えられる。フォークの作者や、
//   権限を外された元コラボレーターが `Closes #N` を書き足すと、このスクリプトが運用者のトークンで Issue を
//   閉じてしまう。bot の PR 本文は、書き込み権限を持つ人しか書き換えられない。
// - マージ後に一度 close されて、いま open の Issue は閉じない。人間が意図して開け直したものを、毎周閉じ直さない。
//
// 使い方:
//   npm run close-issues   close した Issue と、その根拠の PR を1件1行で標準出力に返す。
//                          close するものが無ければ、その旨を返す
//   closeIssuesOfMergedPullRequests({ repository, onClosed })
//                          Auto Programmer（scripts/auto-programmer/index.mjs）が毎周、Issue を選ぶ前に呼ぶ。
//                          契約は下の JSDoc を見よ

import { realpathSync } from 'fs'
import { fileURLToPath } from 'url'

import { runJson, runOrThrow } from './auto-programmer/shell.mjs'

// 遡る PR の件数。マージ済み PR を更新日時の新しい順にこの件数だけ見る。close は何度走らせても結果が変わらない
// ので、範囲を起点から計算せず固定件数にする。走らせる間隔のうちに、これを超える数のマージ済み PR が更新
// （マージ、マージ後のコメントやラベルを含む）されると、古い分を見落とす
const MERGED_PR_SCAN_LIMIT = 100

// マージ済み PR の検索。作者の権限（authorAssociation・author の型）は gh pr list では取れないので GraphQL で引く
const MERGED_PULL_REQUESTS_QUERY =
  'query($searchQuery: String!, $limit: Int!) { search(query: $searchQuery, type: ISSUE, first: $limit) { nodes { ... on PullRequest { number body mergedAt isCrossRepository authorAssociation author { __typename } } } } }'

/**
 * @typedef {object} MergedPullRequest
 * @property {number} number PR の番号
 * @property {string | null} body PR 本文
 * @property {string} mergedAt マージされた日時（ISO 8601, UTC）
 * @property {boolean} isCrossRepository フォークから出た PR なら true
 * @property {string} authorAssociation 作者とリポジトリの関係（OWNER・MEMBER・COLLABORATOR・CONTRIBUTOR など）
 * @property {{ __typename: string } | null} author 作者（bot なら `__typename` が `Bot`。削除済みのユーザーは null）
 */

// PR 作者の authorAssociation のうち、いま Issue を閉じられる権限を持つもの。bot は CONTRIBUTOR になるので、
// bot は author の型で別に判定する
const ISSUE_CLOSER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])

// GitHub が Issue を閉じるキーワード（close・fix・resolve の各活用形）。大文字小文字は区別しない。
// 別リポジトリの Issue（owner/repo#N）は対象外なので、キーワードと `#` の間は「省略できるコロン1つと
// 1つ以上の空白」に限る（`Closes:#N` は拾わない）
const CLOSING_KEYWORD_PATTERN =
  /(?<![\w-])(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+#(\d+)(?!\d)/gi

/**
 * マージ済み PR が閉じ損ねた Issue を close する。
 *
 * 見るのは、既定ブランチへマージされた PR のうち更新日時が新しい MERGED_PR_SCAN_LIMIT 件で、同じリポジトリの
 * ブランチから出て、作者がいま Issue を閉じられる権限を持つ（bot か OWNER・MEMBER・COLLABORATOR）ものだけである。
 * それより古い PR や、フォーク・権限を持たない作者の PR が指す Issue は閉じない。マージ後に一度 close されて
 * いま open の Issue（人間が開け直したもの）も閉じない。
 *
 * @param {{ repository?: string, onClosed: (params: { issueNumber: number, pullRequestNumber: number }) => void }} params
 *   repository: 対象リポジトリ（`owner/repo`）。省略するとカレントディレクトリのリポジトリ /
 *   onClosed: Issue を1件 close するたびに呼ばれる。close を利用者へどう知らせるかは呼び出し側が決める
 * @returns {{ scannedPullRequestCount: number, closedIssueCount: number }} 確認したマージ済み PR の件数と、close した Issue の件数
 * @throws {TechnicalError} gh が失敗したとき（未ログイン・ネットワーク断など）。それまでに close した分は戻さない
 */
export function closeIssuesOfMergedPullRequests({ repository, onClosed }) {
  const openIssueNumbers = listOpenIssueNumbers(repository)
  const mergedPullRequests = listMergedPullRequests(repository)

  const closeTargets = findIssuesToClose({ mergedPullRequests, openIssueNumbers }).filter(
    ({ issueNumber, mergedAt }) => !wasClosedAfterMerge({ issueNumber, mergedAt, repository })
  )
  for (const { issueNumber, pullRequestNumber } of closeTargets) {
    closeIssue({ issueNumber, pullRequestNumber, repository })
    onClosed({ issueNumber, pullRequestNumber })
  }

  return {
    scannedPullRequestCount: mergedPullRequests.length,
    closedIssueCount: closeTargets.length
  }
}

/**
 * CLI として実行したときの本体。close した Issue を1件ごとに出力し、何も無ければその旨を出力する。
 *
 * @returns {void}
 * @throws {TechnicalError} gh が失敗したとき（未ログイン・ネットワーク断など）
 */
function runCli() {
  const { scannedPullRequestCount, closedIssueCount } = closeIssuesOfMergedPullRequests({
    onClosed: ({ issueNumber, pullRequestNumber }) =>
      console.log(`#${issueNumber} を close しました（PR #${pullRequestNumber}）`)
  })
  if (closedIssueCount === 0) {
    console.log(
      `close する Issue はありません（直近 ${scannedPullRequestCount} 件のマージ済み PR を確認）`
    )
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
 * 作者がいま Issue を閉じられる権限を持たない PR は読まない。同じ Issue を複数の PR が指すときは、最後に
 * マージされた PR を根拠にする（一覧の並びには依らない）。
 *
 * @param {{ mergedPullRequests: MergedPullRequest[], openIssueNumbers: Set<number> }} params
 *   mergedPullRequests: マージ済み PR の一覧 / openIssueNumbers: open な Issue 番号の集合
 * @returns {{ issueNumber: number, pullRequestNumber: number, mergedAt: string }[]} close する Issue と、根拠の PR とそのマージ日時
 */
function findIssuesToClose({ mergedPullRequests, openIssueNumbers }) {
  const candidates = mergedPullRequests
    .filter(isAuthoredByIssueCloser)
    .flatMap(({ number: pullRequestNumber, body, mergedAt }) =>
      extractClosingIssueNumbers(body)
        .filter((issueNumber) => openIssueNumbers.has(issueNumber))
        .map((issueNumber) => ({ issueNumber, pullRequestNumber, mergedAt }))
    )

  const targetByIssueNumber = new Map()
  for (const candidate of candidates) {
    const currentTarget = targetByIssueNumber.get(candidate.issueNumber)
    // 開け直した後のマージを wasClosedAfterMerge が見落とさないよう、根拠は最後にマージされた PR にする
    if (!currentTarget || candidate.mergedAt > currentTarget.mergedAt) {
      targetByIssueNumber.set(candidate.issueNumber, candidate)
    }
  }
  return [...targetByIssueNumber.values()]
}

/**
 * PR の本文を書いた人が、いま Issue を閉じられる権限を持つか。
 *
 * 本文はマージ後も作者が書き換えられるので、フォークの作者や権限を外された元コラボレーターの本文を根拠に
 * Issue を閉じないための判定である。
 *
 * @param {MergedPullRequest} pullRequest マージ済み PR
 * @returns {boolean} 同じリポジトリのブランチから出ていて、作者が bot か OWNER・MEMBER・COLLABORATOR なら true
 */
function isAuthoredByIssueCloser({ isCrossRepository, authorAssociation, author }) {
  if (isCrossRepository) return false
  return author?.__typename === 'Bot' || ISSUE_CLOSER_ASSOCIATIONS.has(authorAssociation)
}

/**
 * open な Issue の番号を全件返す。
 *
 * @param {string | undefined} repository 対象リポジトリ（省略するとカレントディレクトリのリポジトリ）
 * @returns {Set<number>} open な Issue 番号の集合（PR は含まない）
 */
function listOpenIssueNumbers(repository) {
  // issues 一覧（REST）は PR も返すので、pull_request を持つものを外す
  const issueNumberLines = runOrThrow('gh', [
    'api',
    '--paginate',
    `${toRepositoryApiPath(repository)}/issues?state=open&per_page=100`,
    '--jq',
    '.[] | select(.pull_request == null) | .number'
  ])
  return new Set(
    issueNumberLines
      .split('\n')
      .filter((line) => line.length > 0)
      .map(Number)
  )
}

/**
 * 既定ブランチへマージされた PR を、更新日時の新しい順に MERGED_PR_SCAN_LIMIT 件返す。
 *
 * @param {string | undefined} repository 対象リポジトリ（省略するとカレントディレクトリのリポジトリ）
 * @returns {MergedPullRequest[]} マージ済み PR の一覧
 */
function listMergedPullRequests(repository) {
  // GitHub が `Closes #N` で Issue を閉じるのは既定ブランチへのマージだけなので、それに揃える
  const { nameWithOwner, defaultBranchRef } = runJson('gh', [
    'repo',
    'view',
    ...(repository ? [repository] : []),
    '--json',
    'nameWithOwner,defaultBranchRef'
  ])
  // 既定の並び（作成順）だと、長く開いていた PR は新しくマージされても件数の窓から落ちる。マージで更新日時が
  // 進むので、更新順で取る
  const searchQuery = `repo:${nameWithOwner} is:pr is:merged base:${defaultBranchRef.name} sort:updated-desc`
  const response = runJson('gh', [
    'api',
    'graphql',
    '-f',
    `query=${MERGED_PULL_REQUESTS_QUERY}`,
    '-f',
    `searchQuery=${searchQuery}`,
    '-F',
    `limit=${MERGED_PR_SCAN_LIMIT}`
  ])
  return response.data.search.nodes
}

/**
 * Issue が、PR のマージ後に一度でも close されたか。
 *
 * いま open の Issue がこれに当たれば、マージ後に close されたあと人間が開け直したものである。
 *
 * @param {{ issueNumber: number, mergedAt: string, repository: string | undefined }} params
 *   issueNumber: 調べる Issue / mergedAt: 根拠の PR がマージされた日時（ISO 8601, UTC） /
 *   repository: 対象リポジトリ（省略するとカレントディレクトリのリポジトリ）
 * @returns {boolean} マージ日時以降に close されていれば true
 * @throws {TechnicalError} gh が失敗したとき（未ログイン・ネットワーク断など）
 */
function wasClosedAfterMerge({ issueNumber, mergedAt, repository }) {
  const closedAtLines = runOrThrow('gh', [
    'api',
    '--paginate',
    `${toRepositoryApiPath(repository)}/issues/${issueNumber}/events`,
    '--jq',
    '.[] | select(.event == "closed") | .created_at'
  ])
  // どちらも ISO 8601 の UTC 表記（同じ桁数）なので、文字列のまま日時の順に比べられる
  return closedAtLines.split('\n').some((closedAt) => closedAt.length > 0 && closedAt >= mergedAt)
}

/**
 * Issue を完了として close し、根拠の PR をコメントに残す。
 *
 * @param {{ issueNumber: number, pullRequestNumber: number, repository: string | undefined }} params
 *   close する Issue と根拠の PR / repository: 対象リポジトリ（省略するとカレントディレクトリのリポジトリ）
 * @returns {void}
 */
function closeIssue({ issueNumber, pullRequestNumber, repository }) {
  runOrThrow('gh', [
    'issue',
    'close',
    String(issueNumber),
    '--reason',
    'completed',
    '--comment',
    `#${pullRequestNumber} がマージ済みなので close する（\`scripts/close-issues.mjs\`）`,
    ...toRepositoryOption(repository)
  ])
}

/**
 * 対象リポジトリを gh の `--repo` 引数にする。
 *
 * @param {string | undefined} repository 対象リポジトリ
 * @returns {string[]} `--repo` 引数（省略時は空。gh がカレントディレクトリから決める）
 */
function toRepositoryOption(repository) {
  return repository ? ['--repo', repository] : []
}

/**
 * 対象リポジトリを `gh api` の REST パスの先頭（`repos/owner/repo`）にする。
 *
 * @param {string | undefined} repository 対象リポジトリ
 * @returns {string} REST パスの先頭（省略時は gh がカレントディレクトリから埋めるプレースホルダ）
 */
function toRepositoryApiPath(repository) {
  return `repos/${repository ?? '{owner}/{repo}'}`
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCli()
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
