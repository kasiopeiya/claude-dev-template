#!/usr/bin/env node
// 責務: PR がマージ済みで取り込み済みのローカルブランチを消し、それを抱える stale worktree もフォルダごと消す。人間が手動で実行する。
//
// 使い方:
//   npm run prune-merged-branches-and-worktrees                消したブランチを1件1行で標準出力に返す
//   npm run prune-merged-branches-and-worktrees -- --dry-run   何も消さず、消す予定のブランチだけを1件1行で返す（`--` は要る）
//   デフォルトブランチと PR は GitHub のリポジトリから引く（gh が要る）。origin/HEAD は使わない。
//   clone 後に GitHub 側で変えても追従せず、`git remote add` だけのリポジトリには無いため
//
// 設計意図（WHY）:
// - 対象は `--merged origin/<デフォルトブランチ>`。引数なしの --merged は HEAD 基準になり、トピックブランチ上では未 push の作業を巻き込む
// - さらに、デフォルトブランチへマージ済みの PR の作業であるブランチに絞る。ローカルの先端が、PR の先端と同じかその祖先で、
//   かつマージ直前のデフォルトブランチに含まれていなければ、その PR の作業とみなす。
//   作ったばかりのブランチも先端が origin/<デフォルトブランチ> から辿れるので、git の履歴だけではマージ済みと見分けられない。
//   PR はブランチ名で引けるが、名前だけで照合すると、マージ済み PR と同じ名前で作り直したブランチまで消す。
//   PR の先端と同じコミットに限らないのは、PR の先端がローカルより先へ進んでいることが多いため（別の clone で直した・取り込んだ）。
//   マージ直前に含まれるかも見るのは、古いデフォルトブランチから作り直したブランチの先端も、PR の先端の祖先になるため。
//   PR の無いブランチ・PR がマージされていないブランチは、取り込み済みでも消す対象にしない（出力もしない）
// - 判定の前に自分で git fetch origin <デフォルトブランチ> を打つ（--dry-run でも打つ）。人間が事前に打つ前提だと、
//   打ち忘れたときに取り込み済みのブランチを黙って消さずにおく
// - 削除は `-d` に限る。git 自身のマージ済みチェックが安全装置になる。-D は未マージの作業と専用 reflog を消すため使わない
//   （.claude/hooks/forbiddenCommandMatcher.mjs 冒頭）
// - worktree は --force なしで外す。未コミットの変更があれば git が拒否し、そのブランチは残す
// - `--dry-run` は、消す前に対象を確かめるために置く。このスクリプトは動作確認をするだけでも実削除になるため
// - 消す操作なので、知らない引数は止める。打ち間違い（`--dryrun` など）が、そのまま実削除になるのを防ぐ
// - `npm run prune-merged-branches-and-worktrees --dry-run`（`--` 抜け）では、npm が --dry-run を自分の設定として吸い取り、
//   引数には残らず環境変数 npm_config_dry_run だけが立つ。確認のつもりが実削除にならないよう、これも dry-run とみなす

import { execFileSync } from 'child_process'
import { realpathSync } from 'fs'
import { fileURLToPath } from 'url'

/**
 * コマンドを1回実行し、標準出力の末尾の改行を落として返す。
 *
 * @param {string} command 実行するコマンド
 * @param {string[]} args コマンドに渡す引数
 * @returns {string} 標準出力
 * @throws {Error} コマンドが失敗したとき。メッセージはその標準エラー、`cause` は終了コード（`status`）を持つ子プロセスのエラー
 */
function runCommand(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trimEnd()
  } catch (error) {
    throw new Error(String(error.stderr ?? error.message).trim(), { cause: error })
  }
}

function git(args) {
  return runCommand('git', args)
}

/**
 * 指定したリポジトリについて、GitHub に設定されたデフォルトブランチ名を引く。
 *
 * @param {string} originUrl origin の URL
 * @returns {string} デフォルトブランチ名
 * @throws {Error} gh が失敗したとき・デフォルトブランチを引けなかったとき
 */
function readDefaultBranchName(originUrl) {
  const defaultBranchName = runCommand('gh', [
    'repo',
    'view',
    originUrl,
    '--json',
    'defaultBranchRef',
    '--jq',
    '.defaultBranchRef.name'
  ])
  // コミットの無い空のリポジトリでは defaultBranchRef が null になり、gh は空文字を返す
  if (defaultBranchName === '') {
    throw new Error(
      'デフォルトブランチを引けませんでした（コミットの無い空のリポジトリではありませんか）'
    )
  }
  return defaultBranchName
}

function gitLines(args) {
  const output = git(args)
  return output === '' ? [] : output.split('\n')
}

/**
 * `ancestor` が `descendant` と同じコミットか、その祖先かを確かめる。
 *
 * @param {{ ancestor: string, descendant: string }} params ancestor: 祖先と見込むコミット / descendant: 子孫と見込むコミット
 * @returns {boolean} 同じか祖先なら true
 * @throws {Error} どちらかのコミットが手元に無いなど、判定できなかったとき
 */
function isAncestorCommit({ ancestor, descendant }) {
  try {
    git(['merge-base', '--is-ancestor', ancestor, descendant])
    return true
  } catch (error) {
    // 終了コード 1 だけが「祖先でない」。それ以外（コミットが手元に無いなど）は判定の失敗なので投げる
    if (error.cause?.status === 1) return false
    throw error
  }
}

/**
 * ローカルブランチが、そのブランチ名から出てデフォルトブランチへマージされた PR の作業かを確かめる。
 * 先端が PR の先端と同じかその祖先で、かつマージ直前のデフォルトブランチに含まれていなければ、その PR の作業とみなす。
 *
 * @param {{ originUrl: string, defaultBranchName: string, branch: string }} params
 *   originUrl: origin の URL / defaultBranchName: PR のマージ先 / branch: 確かめるブランチ名
 * @returns {boolean} 当てはまるマージ済み PR があれば true。PR が無い・マージされていない・PR の作業でなければ false
 * @throws {Error} gh が失敗したとき・PR のコミットが手元に無く判定できなかったとき
 */
function isCoveredByMergedPullRequest({ originUrl, defaultBranchName, branch }) {
  const mergedPullRequests = JSON.parse(
    runCommand('gh', [
      'pr',
      'list',
      '--repo',
      originUrl,
      '--head',
      branch,
      '--base',
      defaultBranchName,
      '--state',
      'merged',
      '--json',
      'headRefOid,mergeCommit'
    ])
  )
  const localTip = `refs/heads/${branch}`
  return mergedPullRequests.some(
    ({ headRefOid, mergeCommit }) =>
      isAncestorCommit({ ancestor: localTip, descendant: headRefOid }) &&
      // マージ直前のデフォルトブランチに含まれる先端は、PR の作業ではなく古いデフォルトブランチから作り直したもの
      !isAncestorCommit({ ancestor: localTip, descendant: `${mergeCommit.oid}^1` })
  )
}

/**
 * 消す候補のブランチを、マージ済み PR の作業と確かめられたものに絞る。PR が無い・マージされていない・PR の作業でない
 * ブランチは黙って除く。gh・git が失敗して判定できなかったブランチは、理由を標準エラーに出して除く。
 *
 * @param {{ originUrl: string, defaultBranchName: string, branches: string[] }} params
 *   originUrl: origin の URL / defaultBranchName: PR のマージ先 / branches: 消す候補のブランチ名
 * @returns {{ coveredBranches: string[], uncheckedCount: number }} マージ済み PR の作業と確かめられたブランチと、判定できなかった件数
 */
function selectBranchesCoveredByMergedPullRequest({ originUrl, defaultBranchName, branches }) {
  const coveredBranches = []
  let uncheckedCount = 0
  for (const branch of branches) {
    let isCovered
    try {
      isCovered = isCoveredByMergedPullRequest({ originUrl, defaultBranchName, branch })
    } catch (error) {
      console.error(`残した: ${branch}: PR を確かめられませんでした: ${error.message}`)
      uncheckedCount++
      continue
    }
    if (isCovered) coveredBranches.push(branch)
  }
  return { coveredBranches, uncheckedCount }
}

/**
 * `git worktree list --porcelain` の1作業フォルダ分を読む。
 *
 * @param {string} block 作業フォルダ1件分の出力（空行で区切られた1ブロック）
 * @returns {{ path: string | undefined, branch: string | undefined }} 作業フォルダの場所と、チェックアウト中のブランチ名
 */
function parseWorktreeBlock(block) {
  const lines = block.split('\n')
  const path = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length)
  const ref = lines.find((line) => line.startsWith('branch '))?.slice('branch '.length)
  return { path, branch: ref?.replace(/^refs\/heads\//, '') }
}

/**
 * 1つのブランチを消す。抱えている worktree があれば先に外す。
 *
 * @param {{ branch: string, worktreePath: string | undefined }} target 消すブランチと、そのブランチを抱える worktree の場所
 * @returns {void}
 * @throws {Error} worktree を外せない・`-d` が拒否したとき（未コミットの変更など）
 */
function deleteBranch({ branch, worktreePath }) {
  const sha = git(['rev-parse', `refs/heads/${branch}`])
  if (worktreePath) {
    git(['worktree', 'remove', worktreePath])
    console.log(`worktree を外した: ${worktreePath}`)
  }
  git(['branch', '-d', branch])
  console.log(`削除: ${branch}（was ${sha}）`)
}

/**
 * PR がマージ済みで取り込み済みのローカルブランチを消す。
 * 消すブランチごとに、抱えている worktree を外してから `-d` で消す。
 *
 * @param {{ dryRun: boolean }} options `dryRun` が true なら、何も消さずに消す予定を出力する
 * @returns {{ deletedCount: number, skippedCount: number, plannedCount: number }}
 *   消した件数・残した（失敗した）件数・`dryRun` で消す予定だった件数
 */
function pruneMergedBranches({ dryRun }) {
  // デフォルトブランチも PR も、取り込み済みの基準 origin/<名前> と同じリポジトリから引く。
  // gh の既定（`upstream` や `GH_REPO`）に任せると、別のリポジトリを見る
  const originUrl = git(['remote', 'get-url', 'origin'])
  const defaultBranchName = readDefaultBranchName(originUrl)
  git(['fetch', 'origin', '--end-of-options', defaultBranchName])
  // 取り込み済みかを判定する基準。ローカルのデフォルトブランチではなく origin 側を見る
  const mergeBase = `origin/${defaultBranchName}`
  const [mainWorktree, ...linkedWorktrees] = git(['worktree', 'list', '--porcelain'])
    .split('\n\n')
    .map(parseWorktreeBlock)
  const currentBranch = git(['branch', '--show-current'])
  const keptBranches = new Set(
    [defaultBranchName, currentBranch, mainWorktree.branch].filter(Boolean)
  )
  const worktreePathByBranch = new Map(
    linkedWorktrees
      .filter((worktree) => worktree.branch)
      .map((worktree) => [worktree.branch, worktree.path])
  )

  const targetBranches = gitLines([
    'branch',
    '--merged',
    mergeBase,
    '--format=%(refname:short)'
  ]).filter((branch) => !keptBranches.has(branch))

  const { coveredBranches, uncheckedCount } = selectBranchesCoveredByMergedPullRequest({
    originUrl,
    defaultBranchName,
    branches: targetBranches
  })

  let deletedCount = 0
  let skippedCount = uncheckedCount
  let plannedCount = 0
  for (const branch of coveredBranches) {
    const worktreePath = worktreePathByBranch.get(branch)
    if (dryRun) {
      console.log(`削除予定: ${branch}${worktreePath ? `（worktree: ${worktreePath}）` : ''}`)
      plannedCount++
      continue
    }
    try {
      deleteBranch({ branch, worktreePath })
      deletedCount++
    } catch (error) {
      console.error(`残した: ${branch}: ${error.message}`)
      skippedCount++
    }
  }
  return { deletedCount, skippedCount, plannedCount }
}

const KNOWN_OPTIONS = new Set(['--dry-run'])

/**
 * コマンドライン引数を読む。
 *
 * @param {string[]} args `--dry-run` などの引数（node とスクリプトのパスは含まない）
 * @param {Record<string, string | undefined>} env 環境変数
 * @returns {{ dryRun: boolean }} 読み取った指定
 * @throws {Error} 知らない引数があるとき
 */
function parseCliOptions(args, env) {
  const unknownOptions = args.filter((cliArgument) => !KNOWN_OPTIONS.has(cliArgument))
  if (unknownOptions.length > 0) {
    throw new Error(`知らない引数です: ${unknownOptions.join(' ')}（使えるのは --dry-run だけ）`)
  }
  return { dryRun: args.includes('--dry-run') || env.npm_config_dry_run === 'true' }
}

/**
 * CLI として実行したときの本体。消したブランチと残したブランチ（`--dry-run` なら消す予定のブランチ）を出力し、
 * 残したものがあれば異常終了する。
 *
 * @returns {void}
 */
function runCli() {
  const { dryRun } = parseCliOptions(process.argv.slice(2), process.env)
  const { deletedCount, skippedCount, plannedCount } = pruneMergedBranches({ dryRun })
  if (deletedCount === 0 && skippedCount === 0 && plannedCount === 0) {
    console.log('消すブランチはありません')
  }
  if (skippedCount > 0) process.exitCode = 1
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCli()
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
