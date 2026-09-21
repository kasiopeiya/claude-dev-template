// 責務: AI 専用 clone で実装を始められる状態を、初回でも手作業なしで整える。
//
// 設計意図（WHY）:
// - clone・依存のインストール・`gh` 認証の確認はすべて機械で実行できる。runbook-policy が
//   「自動化できるものに手順書は要らない」と定めるため、手順書ではなくこのコードが手順そのものになる。
// - ただし `gh auth login` と `claude` の導入は人間の操作が要るので自動化できない。ここでは促して止まる。
// - どの検査も、カードを「着手中」へ動かす前に済ませる。動かした後に落ちると、人間が手でカードを戻す
//   ことになるからである。

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { config } from './config.mjs'
import { runCapture, runOrThrow, runStreaming } from './shell.mjs'

// npm のロックファイル名。これを持つディレクトリごとに依存を入れる
const LOCK_FILE_NAME = 'package-lock.json'

// npm ci が成功した後にだけ node_modules の中へ置く印。npm ci は既存 node_modules の中身を消してから
// 入れるので、途中で落ちると node_modules だけが新しい mtime で残る。ディレクトリではなく印の mtime と比べる
const INSTALL_STAMP_FILE_NAME = '.auto-programmer-installed'

/**
 * 人間が入れておくべきコマンドが使えるかを確かめる。
 *
 * @returns {void}
 * @throws {Error} `gh` が起動できない・未ログインのとき、または `claude` が起動できないとき
 */
function ensureHumanPrerequisites() {
  let ghAuthExitCode
  try {
    // 対象を絞らないと、別ホスト・別アカウントのトークン切れでも失敗扱いになる
    ghAuthExitCode = runCapture('gh', [
      'auth',
      'status',
      '--hostname',
      'github.com',
      '--active'
    ]).exitCode
  } catch (error) {
    throw new Error(
      'gh コマンドを起動できません。GitHub CLI を入れてから、もう一度打ってください',
      {
        cause: error
      }
    )
  }
  if (ghAuthExitCode !== 0) {
    throw new Error(
      'GitHub CLI が未ログインです。`gh auth login` を実行してから、もう一度打ってください'
    )
  }
  try {
    runCapture('claude', ['--version'])
  } catch (error) {
    throw new Error(
      'claude コマンドを起動できません。Claude Code を入れてから、もう一度打ってください',
      { cause: error }
    )
  }
}

/**
 * git の remote URL から owner/repo を取り出す。HTTPS・`git@host:owner/repo`・`ssh://` のどれでもよい。
 *
 * @param {string} remoteUrl `git remote get-url` の出力
 * @returns {string | null} 小文字の owner/repo（取り出せなければ null）
 */
function readRepositoryFromRemoteUrl(remoteUrl) {
  return (
    remoteUrl
      .trim()
      .match(/[/:]([^/:]+\/[^/]+?)(?:\.git)?\/?$/)?.[1]
      .toLowerCase() ?? null
  )
}

/**
 * AI 専用 clone を用意する。すでにあれば、向き先が設定どおりかだけを確かめる。
 *
 * @returns {void}
 * @throws {Error} clone に失敗したとき・既存 clone の向き先が config.repository と違うとき
 */
function ensureWorkspaceClone() {
  if (existsSync(join(config.workspaceDir, '.git'))) {
    // repository だけを書き換えて古い clone を使い続けると、ボードは新リポジトリ・push は旧リポジトリに割れる
    const originUrl = runOrThrow('git', ['remote', 'get-url', 'origin'], {
      cwd: config.workspaceDir
    }).trim()
    if (readRepositoryFromRemoteUrl(originUrl) !== config.repository.toLowerCase()) {
      throw new Error(
        `${config.workspaceDir} の origin（${originUrl}）が ${config.repository} ではありません`
      )
    }
    return
  }

  console.log(`AI 専用 clone を作成します: ${config.workspaceDir}`)
  mkdirSync(dirname(config.workspaceDir), { recursive: true })
  const { exitCode } = runStreaming('gh', ['repo', 'clone', config.repository, config.workspaceDir])
  if (exitCode !== 0) throw new Error(`clone に失敗しました: ${config.repository}`)
}

/**
 * clone 内でロックファイルを持つディレクトリを列挙する。
 *
 * 固定リストにしないのは、ロックファイルが増えたときの直し忘れを防ぐためである。
 *
 * @returns {string[]} clone 直下からの相対パス（直下は `.`）
 * @throws {Error} `git ls-files` に失敗したとき
 */
function listPackageLockDirectories() {
  // pathspec の `*` は `/` もまたぐので、入れ子のロックファイルも拾える。
  // -z を付けないと、日本語などを含むパスがクォート付きで出力されて使えない
  const trackedPaths = runOrThrow('git', ['ls-files', '-z', '--', `*${LOCK_FILE_NAME}`], {
    cwd: config.workspaceDir
  })
    .split('\0')
    .filter(Boolean)
  return trackedPaths.filter((path) => basename(path) === LOCK_FILE_NAME).map(dirname)
}

/**
 * 依存を入れ直す必要があるかを判定する。
 *
 * clone は毎回 origin/main まで戻されるので、main 側で依存が変わるとロックファイルだけが新しくなる。
 *
 * @param {string} directory 判定するディレクトリ（絶対パス）。ロックファイルを持つこと
 * @returns {boolean} 成功した npm ci の印が無いか、印がロックファイルより古ければ true
 */
function needsDependencyInstall(directory) {
  const stampPath = join(directory, 'node_modules', INSTALL_STAMP_FILE_NAME)
  if (!existsSync(stampPath)) return true
  return statSync(join(directory, LOCK_FILE_NAME)).mtimeMs > statSync(stampPath).mtimeMs
}

/**
 * AI 専用 clone の依存を、ロックファイルを持つディレクトリごとにロックファイルどおり入れる。
 * 入っていて最新のディレクトリは飛ばす。
 *
 * @returns {void}
 * @throws {Error} clone 内の `git ls-files` が失敗したとき・`npm` を起動できないとき・`npm ci` が 0 以外で終わったとき
 */
export function ensureDependencies() {
  for (const relativeDirectory of listPackageLockDirectories()) {
    const directory = join(config.workspaceDir, relativeDirectory)
    if (!needsDependencyInstall(directory)) continue

    console.log(`AI 専用 clone に依存をインストールします: ${relativeDirectory}`)
    const { exitCode } = runStreaming('npm', ['ci'], { cwd: directory })
    if (exitCode !== 0) throw new Error(`npm ci に失敗しました: ${relativeDirectory}`)
    writeFileSync(join(directory, 'node_modules', INSTALL_STAMP_FILE_NAME), '')
  }
}

/**
 * Issue を選ぶ前に済ませられる準備を整える。依存は clone を origin/main へ戻した後でないと
 * 判定できないため、ここには含めず ensureDependencies で別に行う。
 *
 * @returns {void}
 * @throws {Error} 人間が済ませるべき準備が無いとき・clone に失敗したとき・既存 clone の origin が config.repository と違うとき
 */
export function runPreflight() {
  ensureHumanPrerequisites()
  ensureWorkspaceClone()
}
