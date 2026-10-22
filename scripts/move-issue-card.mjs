#!/usr/bin/env node
// 責務: `npm run move-issue-card -- <Issue番号>` の入口として、ボードの設定と gh を判断（`issue-card-move.mjs`）へ
//   繋ぐことだけを担う。CLAUDE.md「Issue 作業の共通ルール」が着手の直前に打たせる。
//
// 設計意図（WHY）:
// - 接続先とボードの表記は auto-programmer の config.mjs を共有し、二重に持たない。2か所に持つと、片方だけ直したときに
//   黙って別のボードを触る。
// - ボードが設定されているかは、config.mjs の `repository` と今いるリポジトリの一致で判定する。`scripts/sync-template.sh`
//   は config.mjs を上書きしないので、利用先にはテンプレートのボードを指したまま渡る（Issue #1002）。
// - どの失敗でも警告だけ出して終了コード 0 で終わる（理由は issue-card-move.mjs の設計意図）。
//
// 使い方: npm run move-issue-card -- <Issue番号>
//   動かせたか、動かせなかった理由を1行で返す。終了コードは常に 0

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { runJson } from './auto-programmer/shell.mjs'
import { moveIssueCardToInProgress } from './issue-card-move.mjs'

/**
 * 今いるリポジトリを `owner/repo` で引く。
 *
 * @returns {string} 今いるリポジトリ
 * @throws {Error} gh が失敗したとき（未ログイン・git の外・ネットワーク断など）
 */
function readCurrentRepository() {
  const { nameWithOwner } = runJson('gh', ['repo', 'view', '--json', 'nameWithOwner'])
  if (!nameWithOwner) throw new Error('gh repo view の出力に nameWithOwner がありません')
  return nameWithOwner
}

/**
 * CLI として実行したときの本体。結果を1行で出す。
 *
 * @returns {Promise<void>}
 * @throws {Error} 設定を読み込めないとき
 */
async function runCli() {
  // config.mjs は読み込みの時点で設定を検査して throw し、board.mjs はそれを読む。静的 import だと下の catch の
  // 外で落ち、終了コード 1 とスタックトレースで作業を止めてしまうので、ここで読む
  const { config } = await import('./auto-programmer/config.mjs')
  const { markIssueAsStarted } = await import('./auto-programmer/board.mjs')

  const { message, isWarning } = moveIssueCardToInProgress({
    issueNumber: process.argv[2],
    configuredRepository: config.repository,
    readCurrentRepository,
    moveCard: markIssueAsStarted
  })
  if (isWarning) console.warn(message)
  else console.log(message)
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runCli()
  } catch (error) {
    console.warn(`カードを動かせませんでした: ${error.message}`)
  }
}
