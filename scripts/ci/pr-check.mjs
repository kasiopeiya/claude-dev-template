#!/usr/bin/env node
// 責務: PR の差分が、レビューを依頼してよい大きさに収まっているかを判定し、結果を PR に1件コメントする。
//   閾値と「機械的な変更を除いて数える」という基準は docs/policy/pr-review-policy.md の
//   「PRは小さく保つほどレビュー品質が上がる」節が正典で、ここはその判定だけを担う。
//   足し算と比較しかしないので AI には数えさせない。数え間違いで同じ PR の判定が変わるため（Issue #631）。
//
// 判定ロジックはこのファイル1ヶ所にしか置かない。手元の /pr-check と CI（pr-ai-triage.yml）の2経路から呼ばれる。
// NG でも終了コードは 0 を返す。マージを止めるゲートではないため。
//
// 使い方: node scripts/ci/pr-check.mjs [PR番号]（省略すると現ブランチの PR）

import { execFileSync } from 'child_process'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

import { BusinessError } from '../lib/errors.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')

// pr-review-policy のサイズ区分「大」の下限。この行数以上を NG とする
const LARGE_PR_LINES = 400

// 機械的な変更として数えないファイル（ほかに .gitignore に載っているパスも数えない）。
// 当てはまるか迷うものは足さない。除外の幅が広がるほど、数え方次第で同じ PR の合計が変わる。
const MECHANICAL_FILE_PATTERNS = [
  /-lock\.json$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /\.snap$/
]

function main() {
  const prNumber = resolvePrNumber(process.argv[2])
  const reviewedLineCount = countReviewedLines(fetchChangedFiles(prNumber))
  const verdict = isLargePr(reviewedLineCount) ? 'NG' : 'OK'
  // 本文は標準入力で渡す。本文の改行や記号でコマンド行を壊さないため
  const commentUrl = runGhCommand(
    ['pr', 'comment', prNumber, '--body-file', '-'],
    formatComment(reviewedLineCount)
  ).trim()

  console.log(
    `PR #${prNumber}: ${verdict}（差分 ${reviewedLineCount} 行。${LARGE_PR_LINES} 行以上で NG）`
  )
  console.log(`コメント: ${commentUrl}`)
}

/**
 * 対象の PR 番号を返す。引数が無ければ現ブランチに紐づく PR を引く。
 *
 * @param {string | undefined} argument コマンドライン引数
 * @returns {string} PR 番号
 * @throws {BusinessError} 引数が数字でないとき、または引数が無く現ブランチに紐づく PR が無いとき
 */
function resolvePrNumber(argument) {
  if (argument !== undefined) {
    if (!/^\d+$/.test(argument)) {
      throw new BusinessError(`PR 番号は数字で渡してください: ${argument}`)
    }
    return argument
  }

  try {
    return runGhCommand(['pr', 'view', '--json', 'number', '--jq', '.number']).trim()
  } catch {
    throw new BusinessError(
      '現ブランチに紐づく PR が見つかりません。PR 番号を引数で渡すか、push して PR ができてから実行してください。'
    )
  }
}

/**
 * PR の変更ファイルを全件返す。`gh pr view --json files` は先頭100件で打ち切られるため、
 * REST API をページ送りして取る。
 *
 * @param {string} prNumber PR 番号
 * @returns {{ path: string, additions: number, deletions: number }[]} 変更ファイル
 */
function fetchChangedFiles(prNumber) {
  return runGhCommand([
    'api',
    '--paginate',
    `repos/{owner}/{repo}/pulls/${prNumber}/files`,
    '--jq',
    '.[] | {path: .filename, additions, deletions}'
  ])
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

/**
 * レビューで読む行数（機械的な変更を除いた、追加と削除の合計）を返す。
 *
 * @param {{ path: string, additions: number, deletions: number }[]} files 変更ファイル
 * @returns {number} 行数
 */
function countReviewedLines(files) {
  const ignoredPaths = findGitIgnored(files.map(({ path }) => path))

  return files
    .filter(
      ({ path }) =>
        !ignoredPaths.has(path) && !MECHANICAL_FILE_PATTERNS.some((pattern) => pattern.test(path))
    )
    .reduce((sum, { additions, deletions }) => sum + additions + deletions, 0)
}

/**
 * `.gitignore` に載っているパスを返す。追跡済みのファイルも `.gitignore` の記述だけで
 * 判定するため `--no-index` を付ける。
 *
 * @param {string[]} paths 判定するパス
 * @returns {Set<string>} `.gitignore` に載っているパス
 */
function findGitIgnored(paths) {
  try {
    const output = execFileSync('git', ['check-ignore', '--no-index', '--stdin', '-z'], {
      cwd: repoRoot,
      encoding: 'utf8',
      input: paths.join('\0')
    })
    return new Set(output.split('\0').filter(Boolean))
  } catch (error) {
    // 終了コード 1 は「どのパスも載っていない」という正常な結果
    if (error.status === 1) {
      return new Set()
    }
    throw error
  }
}

/**
 * PR に投稿するコメント本文を返す。pr-review-policy へのリンクは入れない（コメントの可搬性を保つため）。
 *
 * @param {number} reviewedLineCount レビューで読む行数
 * @returns {string} コメント本文
 */
function formatComment(reviewedLineCount) {
  if (!isLargePr(reviewedLineCount)) {
    return `## PRレビュー前提チェック: OK\n\n差分は ${reviewedLineCount} 行です（ロックファイルなど機械的な変更を除く）。`
  }

  return [
    '## PRレビュー前提チェック: NG',
    '',
    'レビューを依頼する前に、以下を満たしてください。',
    '',
    `MUST: 差分が ${reviewedLineCount} 行で、サイズ区分「大」（${LARGE_PR_LINES} 行以上）です。分割を検討してください。`
  ].join('\n')
}

/**
 * レビューで読む行数が、サイズ区分「大」（NG）にあたるかを返す。
 *
 * @param {number} reviewedLineCount レビューで読む行数
 * @returns {boolean} 「大」なら true
 */
function isLargePr(reviewedLineCount) {
  return reviewedLineCount >= LARGE_PR_LINES
}

/**
 * gh を実行して標準出力を返す。
 *
 * @param {string[]} args gh に渡す引数
 * @param {string} [input] 標準入力に流す文字列
 * @returns {string} 標準出力
 */
function runGhCommand(args, input) {
  return execFileSync('gh', args, { cwd: repoRoot, encoding: 'utf8', input })
}

try {
  main()
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
