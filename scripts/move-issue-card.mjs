#!/usr/bin/env node
// 責務: `npm run move-issue-card -- <Issue番号>` の入口として、着手した Issue のカードをボードの「着手中」へ
//   動かすことだけを担う。CLAUDE.md「Issue 作業の共通ルール」が着手の直前に打たせる。
//
// 設計意図（WHY）:
// - どの失敗でも例外にせず、警告を1行出して終了コード 0 で終わる。Status は人間が進み具合を見るための表示なので、
//   動かせないことを理由に作業ごと止める方が損が大きい（Issue #1002）。
// - 接続先とボードの表記は auto-programmer の config.mjs を共有し、二重に持たない。2か所に持つと、片方だけ直した
//   ときに黙って別のボードを触る。
// - ボードが設定されているかは、config.mjs の `repository` と今いるリポジトリの一致で判定する。`scripts/sync-template.sh`
//   は config.mjs を上書きしないので、利用先にはテンプレートのボードを指したまま渡る（Issue #1002）。
// - 動かした先の表記は `markIssueAsStarted` の戻り値から取る。こちらでも持つと、動かした先とメッセージが名乗る先がずれる。
//
// 使い方: npm run move-issue-card -- <Issue番号>
//   動かせたか、動かせなかった理由を1行で返す。終了コードは常に 0

import { runJson } from './auto-programmer/shell.mjs'

const USAGE_MESSAGE = 'Issue 番号を渡してください（例: npm run move-issue-card -- 123）'

// gh が、トークンのスコープ不足で断ったときに出すメッセージ。`gh project` には `project` スコープが要る
const MISSING_SCOPE_PATTERN = /missing required scopes/i

/**
 * 渡された引数が Issue 番号として読めるか。
 *
 * @param {string | undefined} rawIssueNumberArgument コマンドラインから渡された、まだ検証していない引数
 * @returns {boolean} 1 以上の整数として読めれば true
 */
function isIssueNumber(rawIssueNumberArgument) {
  return /^[1-9]\d*$/.test(rawIssueNumberArgument ?? '')
}

/**
 * 2つのリポジトリが同じものを指すか。
 *
 * GitHub は `owner/repo` の大文字小文字を区別しないので、綴りの違いは同じリポジトリとして扱う。
 *
 * @param {string} oneRepository 比べるリポジトリ（`owner/repo`）
 * @param {string} otherRepository 比べる相手のリポジトリ（`owner/repo`）
 * @returns {boolean} 同じリポジトリを指していれば true
 */
function isSameRepository(oneRepository, otherRepository) {
  return oneRepository.toLowerCase() === otherRepository.toLowerCase()
}

/**
 * カードを動かせなかった原因から、人間に出す1行を決める。
 *
 * @param {Error} error カードを動かせなかった原因（gh の失敗・設定の不備・ボードの表記違いなど）
 * @returns {string} 警告として出す1行
 */
function describeMoveFailure(error) {
  if (MISSING_SCOPE_PATTERN.test(error.message)) {
    return `ボードを操作する権限がありません。\`gh auth refresh -s project\` で許可してください: ${error.message}`
  }
  return `カードを動かせませんでした: ${error.message}`
}

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
 * @throws {Error} 設定を読み込めないとき・gh が失敗したとき
 */
async function runCli() {
  const issueNumber = process.argv[2]
  if (!isIssueNumber(issueNumber)) {
    console.warn(USAGE_MESSAGE)
    return
  }

  // config.mjs は読み込みの時点で設定を検査して throw し、board.mjs はそれを読む。静的 import だと下の catch の
  // 外で落ち、終了コード 1 とスタックトレースで作業を止めてしまうので、ここで読む
  const { config } = await import('./auto-programmer/config.mjs')
  const { markIssueAsStarted } = await import('./auto-programmer/board.mjs')

  const currentRepository = readCurrentRepository()
  if (!isSameRepository(currentRepository, config.repository)) {
    console.warn(
      `ボードが設定されていないので、カードを動かしません（config.mjs の repository は ${config.repository} で、今いるリポジトリは ${currentRepository} です）`
    )
    return
  }

  const movedStatusName = markIssueAsStarted(
    `https://github.com/${config.repository}/issues/${issueNumber}`
  )
  console.log(`#${issueNumber} のカードを ${movedStatusName} へ動かしました`)
}

try {
  await runCli()
} catch (error) {
  console.warn(describeMoveFailure(error))
}
