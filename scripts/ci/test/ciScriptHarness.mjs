// 責務: scripts/ci/ のスクリプトを、使い捨ての git リポジトリの中で実際に走らせるテスト用の道具。
//   スクリプトは export を持たず、リポジトリ直下を自分の置き場所から決めるため、
//   一時リポジトリへ scripts/ci/ ごと写して子プロセスで動かし、終了コードと出力だけを見る。
//   npm・gh のようなプロセス外の依存は、PATH の先頭に置く偽のコマンドで差し替える。

import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { devNull, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CI_SCRIPTS_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), '..')

// 開発者の global・system の git 設定（コミット署名・hooks・core.quotePath など）をテストに持ち込まない。
// 持ち込むと、署名を有効にした開発機だけで準備が落ちたり、再現したい挙動が変わったりする
const ISOLATED_GIT_ENVIRONMENT = { GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' }

const createdDirectories = []

/**
 * テストが作る一時ディレクトリを作る。`removeTemporaryDirectories` でまとめて消す。
 *
 * @param {string} prefix ディレクトリ名の先頭
 * @returns {string} 作ったディレクトリの絶対パス
 */
export function createTemporaryDirectory(prefix) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), prefix))
  createdDirectories.push(temporaryDirectory)
  return temporaryDirectory
}

/** `createTemporaryDirectory` で作ったディレクトリをすべて消す。テストファイルの `after` に渡す */
export function removeTemporaryDirectories() {
  for (const temporaryDirectory of createdDirectories.splice(0)) {
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}

/**
 * git を実行する。失敗したらテストの準備が壊れているので、例外にして止める。
 *
 * @param {string} repositoryRoot 作業ディレクトリ
 * @param {string[]} args git に渡す引数
 * @returns {string} 標準出力
 */
function runGit(repositoryRoot, args) {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args],
    { cwd: repositoryRoot, encoding: 'utf8', env: { ...process.env, ...ISOLATED_GIT_ENVIRONMENT } }
  )
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} が失敗: ${result.stderr}`)
  return result.stdout
}

/**
 * 使い捨ての git リポジトリを作り、scripts/ci/ のスクリプトを写す（テストファイルは写さない）。
 *
 * @returns {string} リポジトリ直下の絶対パス
 */
export function createRepositoryWithCiScripts() {
  const repositoryRoot = createTemporaryDirectory('ci-script-test-')
  runGit(repositoryRoot, ['init', '--quiet'])
  cpSync(CI_SCRIPTS_DIRECTORY, join(repositoryRoot, 'scripts/ci'), {
    recursive: true,
    filter: (sourcePath) => basename(sourcePath) !== 'test'
  })
  return repositoryRoot
}

/**
 * ファイルを書く。親ディレクトリが無ければ作る。
 *
 * @param {string} repositoryRoot リポジトリ直下
 * @param {string} relativePath リポジトリ相対パス
 * @param {string} content 書く内容
 */
export function writeRepositoryFile(repositoryRoot, relativePath, content) {
  const absolutePath = join(repositoryRoot, relativePath)
  mkdirSync(dirname(absolutePath), { recursive: true })
  writeFileSync(absolutePath, content)
}

/**
 * 作業ツリーの変更をすべてコミットし、そのコミットの SHA を返す。
 *
 * @param {string} repositoryRoot リポジトリ直下
 * @returns {string} コミット SHA
 */
export function commitAll(repositoryRoot) {
  runGit(repositoryRoot, ['add', '--all'])
  runGit(repositoryRoot, ['commit', '--quiet', '--message', 'テスト用のコミット'])
  return runGit(repositoryRoot, ['rev-parse', 'HEAD']).trim()
}

/**
 * PATH の先頭に置く偽のコマンドを書き出す。
 *
 * @param {string} commandName コマンド名（npm・gh など）
 * @param {string} nodeSource 偽のコマンドの本体（Node のスクリプト）
 * @returns {string} 偽のコマンドを置いたディレクトリ。runCiScript の fakeCommandDirectory に渡す
 */
export function createFakeCommand(commandName, nodeSource) {
  const fakeCommandDirectory = createTemporaryDirectory('ci-script-fake-bin-')
  const commandPath = join(fakeCommandDirectory, commandName)
  writeFileSync(commandPath, `#!/usr/bin/env node\n${nodeSource}`)
  chmodSync(commandPath, 0o755)
  return fakeCommandDirectory
}

/**
 * 写したスクリプトを子プロセスで動かす。
 *
 * @param {object} invocation 実行の指定
 * @param {string} invocation.scriptPath 実行する Node スクリプトの絶対パス
 * @param {string} invocation.workingDirectory 作業ディレクトリ
 * @param {string} [invocation.fakeCommandDirectory] PATH の先頭に足すディレクトリ
 * @param {Record<string, string>} [invocation.environment] 足す環境変数
 * @returns {{ status: number | null, stdout: string, stderr: string }} 終了コードと出力
 */
export function runCiScript({
  scriptPath,
  workingDirectory,
  fakeCommandDirectory,
  environment = {}
}) {
  const pathWithFakeCommands = fakeCommandDirectory
    ? `${fakeCommandDirectory}:${process.env.PATH}`
    : process.env.PATH
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: workingDirectory,
    encoding: 'utf8',
    env: { ...process.env, ...ISOLATED_GIT_ENVIRONMENT, ...environment, PATH: pathWithFakeCommands }
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}
