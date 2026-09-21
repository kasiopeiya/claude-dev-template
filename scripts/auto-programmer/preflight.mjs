// 責務: AI 専用 clone で実装を始められる状態を、初回でも手作業なしで整える。
//
// 設計意図（WHY）:
// - clone・依存のインストール・`gh` 認証の確認はすべて機械で実行できる。runbook-policy が
//   「自動化できるものに手順書は要らない」と定めるため、手順書ではなくこのコードが手順そのものになる。
// - ただし `gh auth login` と `claude` の導入は人間の操作が要るので自動化できない。ここでは促して止まる。
// - どの検査も、カードを「着手中」へ動かす前に済ませる。動かした後に落ちると、人間が手でカードを戻す
//   ことになるからである。

import { existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { config } from './config.mjs'
import { runCapture, runStreaming } from './shell.mjs'

/**
 * 人間が入れておくべきコマンドが使えるかを確かめる。
 *
 * @returns {void}
 * @throws {Error} `gh` が未ログイン、または `claude` が起動できないとき
 */
function ensureHumanPrerequisites() {
  if (runCapture('gh', ['auth', 'status']).exitCode !== 0) {
    throw new Error(
      'GitHub CLI が未ログインです。`gh auth login` を実行してから、もう一度打ってください'
    )
  }
  try {
    runCapture('claude', ['--version'])
  } catch {
    throw new Error(
      'claude コマンドが見つかりません。Claude Code を入れてから、もう一度打ってください'
    )
  }
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
    const originUrl = runCapture('git', ['remote', 'get-url', 'origin'], {
      cwd: config.workspaceDir
    }).stdout.trim()
    if (!originUrl.replace(/\.git$/, '').endsWith(`/${config.repository}`)) {
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
 * 依存を入れ直す必要があるかを判定する。
 *
 * clone は毎回 origin/main まで戻されるので、main 側で依存が変わるとロックファイルだけが新しくなる。
 *
 * @returns {boolean} node_modules が無いか、ロックファイルより古ければ true
 */
function needsDependencyInstall() {
  const nodeModulesPath = join(config.workspaceDir, 'node_modules')
  if (!existsSync(nodeModulesPath)) return true
  const lockFilePath = join(config.workspaceDir, 'package-lock.json')
  return statSync(lockFilePath).mtimeMs > statSync(nodeModulesPath).mtimeMs
}

/**
 * AI 専用 clone の依存をロックファイルどおりに入れる。入っていて最新なら何もしない。
 *
 * @returns {void}
 * @throws {Error} `npm ci` に失敗したとき
 */
export function ensureDependencies() {
  if (!needsDependencyInstall()) return

  console.log('AI 専用 clone に依存をインストールします')
  const { exitCode } = runStreaming('npm', ['ci'], { cwd: config.workspaceDir })
  if (exitCode !== 0) throw new Error('npm ci に失敗しました')
}

/**
 * Issue を選ぶ前に済ませられる準備を整える。依存は clone を origin/main へ戻した後でないと
 * 判定できないため、ここには含めず ensureDependencies で別に行う。
 *
 * @returns {void}
 * @throws {Error} 人間が済ませるべき準備が無いとき・clone に失敗したとき
 */
export function runPreflight() {
  ensureHumanPrerequisites()
  ensureWorkspaceClone()
}
