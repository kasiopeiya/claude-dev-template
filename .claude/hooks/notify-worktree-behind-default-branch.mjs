#!/usr/bin/env node
// SessionStart hook: セッションの開始時にデフォルトブランチを fetch し、作業ツリーが遅れていれば、
// 遅れたコミット数と最新の版を読む指示を AI の文脈に流す。
//
// 設計意図（WHY）:
// - 古い作業ツリーのまま調べると、撤廃済みの規定を前提にした計画や実装になる。古いという状態は成果物に残らず、
//   後段のゲートでは届かないので、開始時に機械で確かめる（ポリシー駆動開発ポリシーの「開始時の状態を知らせる」）。
// - SessionStart の標準出力は、終了コード 0 なら AI の文脈に入る。何が起きても exit 0 で終え、セッションの開始を止めない。
// - 確かめられないときは、想定外の失敗も含めて黙らず1行で伝える。無出力は「遅れていない」の意味なので、
//   黙ると、確認できなかったのか遅れていないのかを AI が区別できない。
// - fetch するのはデフォルトブランチだけにする。要るのはその1本との差だけで、全ブランチを取ると開始が遅れる。
// - 比べる相手は完全な参照名（refs/remotes/origin/<名前>）で書く。`origin/main` という名前のローカルブランチが
//   あると、短い名前はそちらを指し、遅れていても 0 と数える。
// - 作業ツリーは CLAUDE_PROJECT_DIR ではなく stdin の cwd で決める（sessionWorktreeRoot.mjs）。置き場所で決めると、
//   EnterWorktree で入った worktree ではなく元のフォルダの遅れを知らせてしまう。

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readOriginDefaultBranchName } from './originDefaultBranch.mjs'
import { findSessionWorktreeRoot } from './sessionWorktreeRoot.mjs'

const hookDirectory = dirname(fileURLToPath(import.meta.url))
// .claude/hooks/ からプロジェクトルートへ。stdin の cwd から作業ツリーを決められないときの既定
const hookProjectRoot = resolve(hookDirectory, '../..')

// fetch 1回の上限。セッションの開始をこれ以上待たせない。10秒は実測の裏付けが無い目安
const FETCH_TIMEOUT_MS = 10_000
// ローカルの参照だけを読む git の上限。git が応答しないときに開始を止めないため
const GIT_QUERY_TIMEOUT_MS = 1000
// fetch の失敗の種類ごとの、AI に伝える理由
const FETCH_FAILURE_REASONS = {
  timedOut: `git fetch が ${FETCH_TIMEOUT_MS / 1000} 秒で終わらなかった`,
  remoteBranchMissing:
    'origin/HEAD が指すブランチがリモートに無い。リモートでデフォルトブランチの名前が変わったなら `git remote set-head origin --auto` で引き直す',
  failed: 'オフラインや認証切れなどで git fetch が失敗した'
}

function main() {
  const lagMessage = fetchAndDescribeWorktreeLag(readSessionWorktreeRoot())
  if (lagMessage !== undefined) process.stdout.write(`${lagMessage}\n`)
}

/**
 * hook の入力からセッションの作業ツリーのルートを決める。決められなければ hook の置き場所を返す。
 *
 * @returns {string} 作業ツリーのルート
 */
function readSessionWorktreeRoot() {
  try {
    const hookInput = JSON.parse(readFileSync(0, 'utf8'))
    return findSessionWorktreeRoot(hookInput?.cwd, hookProjectRoot) ?? hookProjectRoot
  } catch {
    return hookProjectRoot
  }
}

/**
 * origin からデフォルトブランチを fetch して（最大 FETCH_TIMEOUT_MS 待ち、そのリモート追跡ブランチを更新する）、
 * 作業ツリーが遅れているかを確かめ、AI に流す文面を返す。
 *
 * @param {string} worktreeRoot 作業ツリーのルート
 * @returns {string | undefined} 遅れているか、確かめられなかったときの文面。遅れていなければ undefined
 */
function fetchAndDescribeWorktreeLag(worktreeRoot) {
  const defaultBranchName = readOriginDefaultBranchName(worktreeRoot)
  if (defaultBranchName === undefined) {
    return formatUncheckedMessage(
      'origin/HEAD からデフォルトブランチ名を引けない、または名前に想定外の文字を含む'
    )
  }
  const fetchFailure = fetchDefaultBranch(worktreeRoot, defaultBranchName)
  if (fetchFailure !== undefined) return formatUncheckedMessage(FETCH_FAILURE_REASONS[fetchFailure])
  const remoteTrackingRef = `refs/remotes/origin/${defaultBranchName}`
  const behindCommitCount = countCommitsBehind(worktreeRoot, remoteTrackingRef)
  if (behindCommitCount === undefined) return formatUncheckedMessage('遅れたコミットを数えられない')
  if (behindCommitCount === 0) return undefined
  return `作業ツリーは ${remoteTrackingRef} より ${behindCommitCount} コミット遅れている。調べる・計画する・編集する前に、\`git merge --no-edit ${remoteTrackingRef}\` で取り込むか、\`git show ${remoteTrackingRef}:<パス>\` で最新の版を読む。遅れた版をもとにすると、撤廃済みの規定を前提にした計画や実装になる。`
}

/**
 * 遅れを確かめられなかったときの文面を作る。
 *
 * @param {string} reason 確かめられなかった理由
 * @returns {string} AI に流す1行
 */
function formatUncheckedMessage(reason) {
  return `作業ツリーがデフォルトブランチより遅れていないかを確認できなかった（${reason}）。最新の版を前提にせず、必要なら \`git fetch\` してから調べる。`
}

/**
 * origin からデフォルトブランチだけを fetch する。
 *
 * @param {string} worktreeRoot 作業ツリーのルート
 * @param {string} defaultBranchName デフォルトブランチ名
 * @returns {keyof typeof FETCH_FAILURE_REASONS | undefined} 失敗の種類。成功したら undefined
 */
function fetchDefaultBranch(worktreeRoot, defaultBranchName) {
  // --no-write-fetch-head：FETCH_HEAD を書き換えない。直前に人や AI が fetch した版を、開始のたびに上書きしないため
  // --end-of-options：リモートが決めたブランチ名を、オプションとして読ませないため
  const fetchArgs = ['fetch', '--quiet', '--no-write-fetch-head', '--end-of-options']
  try {
    execFileSync('git', ['-C', worktreeRoot, ...fetchArgs, 'origin', defaultBranchName], {
      // Windows は実行ファイルを PATH より先に作業ディレクトリから探す。信頼できない cwd にしないため、hook の置き場所に固定する
      cwd: hookDirectory,
      encoding: 'utf8',
      // GIT_TERMINAL_PROMPT：認証を求められても入力する人がいない。プロンプトで固まらず、失敗として返させる
      // LC_ALL：標準エラーの英語の文言で失敗の種類を見分けるため、翻訳させない
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      // 標準エラーは種類の見分けにだけ使い、文面へは載せない。リモートの URL に入った認証情報を AI の文脈へ出さないため
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: FETCH_TIMEOUT_MS
    })
    return undefined
  } catch (error) {
    return classifyFetchFailure(error)
  }
}

/**
 * git fetch の失敗を種類に分ける。
 *
 * @param {unknown} error execFileSync が投げた例外
 * @returns {keyof typeof FETCH_FAILURE_REASONS} 失敗の種類
 */
function classifyFetchFailure(error) {
  if (!(error instanceof Error)) return 'failed'
  if ('code' in error && error.code === 'ETIMEDOUT') return 'timedOut'
  const gitStandardError = 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : ''
  return gitStandardError.includes("couldn't find remote ref") ? 'remoteBranchMissing' : 'failed'
}

/**
 * HEAD に無く、デフォルトブランチにあるコミットを数える。
 *
 * @param {string} worktreeRoot 作業ツリーのルート
 * @param {string} remoteTrackingRef デフォルトブランチのリモート追跡ブランチの完全な参照名
 * @returns {number | undefined} 遅れたコミット数。数えられなければ undefined
 */
function countCommitsBehind(worktreeRoot, remoteTrackingRef) {
  try {
    const countOutput = execFileSync(
      'git',
      ['-C', worktreeRoot, 'rev-list', '--count', `HEAD..${remoteTrackingRef}`],
      {
        cwd: hookDirectory,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: GIT_QUERY_TIMEOUT_MS
      }
    )
    const behindCommitCount = Number.parseInt(countOutput, 10)
    return Number.isNaN(behindCommitCount) ? undefined : behindCommitCount
  } catch {
    return undefined
  }
}

try {
  main()
} catch {
  // fail-open でも黙らない。無出力は「遅れていない」の意味になるため、確認できなかったことを1行で伝える
  process.stdout.write(`${formatUncheckedMessage('hook の想定外の失敗')}\n`)
}
