#!/usr/bin/env node
// 責務: 取り込み済みのローカルブランチと、それを抱える stale worktree を掃除する。人間が手動で実行する。
//
// 使い方（先に git fetch で origin/<デフォルトブランチ> を最新にする）:
//   npm run prune-branches   消したブランチを1件1行で標準出力に返す
//   デフォルトブランチは GitHub のリポジトリ設定から引く（gh が要る）。origin/HEAD は使わない。
//   clone 後に GitHub 側で変えても追従せず、`git remote add` だけのリポジトリには無いため
//
// 設計意図（WHY）:
// - 対象は `--merged origin/<デフォルトブランチ>`。引数なしの --merged は HEAD 基準になり、トピックブランチ上では未 push の作業を巻き込む
// - 削除は `-d` に限る。git 自身のマージ済みチェックが安全装置になる。-D は未マージの作業と専用 reflog を消すため使わない
//   （.claude/hooks/forbiddenCommandMatcher.mjs 冒頭）
// - worktree は --force なしで外す。未コミットの変更があれば git が拒否し、そのブランチは残す

import { execFileSync } from 'child_process'
import { realpathSync } from 'fs'
import { fileURLToPath } from 'url'

/**
 * コマンドを1回実行し、標準出力の末尾の改行を落として返す。
 *
 * @param {string} command 実行するコマンド
 * @param {string[]} args コマンドに渡す引数
 * @returns {string} 標準出力
 * @throws {Error} コマンドが失敗したとき。メッセージはその標準エラー
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
 * origin に対応する GitHub のリポジトリについて、設定されたデフォルトブランチ名を引く。
 * 取り込み済みの基準は `origin/<名前>` なので、gh の既定（`upstream` や `GH_REPO`）ではなく origin を明示して引く。
 *
 * @returns {string} デフォルトブランチ名
 * @throws {Error} origin が無い・gh が失敗したとき・デフォルトブランチを引けなかったとき
 */
function readDefaultBranchName() {
  const defaultBranchName = runCommand('gh', [
    'repo',
    'view',
    git(['remote', 'get-url', 'origin']),
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
 * 取り込み済みのローカルブランチを消す。
 * 消すブランチごとに、抱えている worktree を外してから `-d` で消す。
 *
 * @returns {{ deletedCount: number, skippedCount: number }} 消した件数と、残した（失敗した）件数
 */
function pruneMergedBranches() {
  const defaultBranchName = readDefaultBranchName()
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

  let deletedCount = 0
  let skippedCount = 0
  for (const branch of targetBranches) {
    try {
      deleteBranch({ branch, worktreePath: worktreePathByBranch.get(branch) })
      deletedCount++
    } catch (error) {
      console.error(`残した: ${branch}: ${error.message}`)
      skippedCount++
    }
  }
  return { deletedCount, skippedCount }
}

/**
 * CLI として実行したときの本体。消したブランチと残したブランチを出力し、残したものがあれば異常終了する。
 *
 * @returns {void}
 */
function runCli() {
  const { deletedCount, skippedCount } = pruneMergedBranches()
  if (deletedCount === 0 && skippedCount === 0) {
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
