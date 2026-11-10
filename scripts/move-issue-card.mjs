#!/usr/bin/env node
// 責務: 着手した Issue に、着手したことを記録することだけを担う。自分（`gh` にログインしているアカウント）を担当者に
//   足し、カードをボードの「着手中」へ動かす。CLAUDE.md「Issue 作業の共通ルール」が着手の直前に打たせる。
//
// 設計意図（WHY）:
// - どの失敗でも例外にせず、警告を1行出して終了コード 0 で終わる。担当者も Status も、誰がいつ着手したかを残す記録なので、
//   付けられないことを理由に作業ごと止める方が損が大きい（Issue #1002）。担当者を足せなくてもカードは動かしにいく。
// - 担当者を足すのは、人ごとに集計できるようにするためである（`scripts/progress-report.mjs` は担当者で人を分ける）。
//   起票時に付く担当者は起票した人なので、着手した人が違うと記録に残らない（Issue #1748）。
// - 担当者は、config.mjs を読み込む前に、今いるリポジトリの Issue へ足す（`gh` に --repo を付けない）。config.mjs は
//   読み込みの時点で設定を検査して throw しうるので、後ろに置くと、その回は担当者が漏れる。ボードが設定されていない
//   利用先でも担当者は要る。`/progress-report` はボードを使わず、今いるリポジトリの担当者を読むからである。同じ理由で、
//   config.mjs の repository の Issue を触る board.mjs の `putOnReadyAssignedToMe` は使わない。
// - 接続先とボードの表記は auto-programmer の config.mjs を共有し、二重に持たない。2か所に持つと、片方だけ直した
//   ときに黙って別のボードを触る。
// - ボードが設定されているかは、config.mjs の `repository` と今いるリポジトリの一致で判定する。`scripts/sync-template.sh`
//   は config.mjs を上書きしないので、利用先にはテンプレートのボードを指したまま渡る（Issue #1002）。
// - 動かした先の表記は `markIssueAsStarted` の戻り値から取る。こちらでも持つと、動かした先とメッセージが名乗る先がずれる。
//
// 使い方: npm run move-issue-card -- <Issue番号>
//   担当者を足せたかと、カードを動かせたかを1行ずつ返す（できなかったときは、その理由）

import { runJson, runOrThrow } from './auto-programmer/shell.mjs'
import { TechnicalError } from './lib/errors.mjs'

const USAGE_MESSAGE = 'Issue 番号を渡してください（例: npm run move-issue-card -- 123）'

// gh が、トークンのスコープ不足で断ったときに出すメッセージ。`gh project` には `project` スコープが要る
const MISSING_SCOPE_PATTERN = /missing required scopes/i

/**
 * CLI として実行したときの本体。担当者とカードの結果を1行ずつ出す。
 *
 * @returns {Promise<void>}
 * @throws {TechnicalError} 設定を読み込めないとき・gh が失敗したとき（担当者を足す処理の失敗は含まない）
 */
async function runCli() {
  const issueNumber = process.argv[2]
  if (!isIssueNumber(issueNumber)) {
    console.warn(USAGE_MESSAGE)
    return
  }

  addMyselfAsAssignee(issueNumber)

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

/**
 * 今いるリポジトリの Issue の担当者に自分を足し、結果を1行で出す。すでにいる担当者は外さない。
 * 失敗しても例外にせず、理由を警告として1行出す。
 *
 * @param {string} issueNumber 検証済みの Issue 番号
 * @returns {void}
 */
function addMyselfAsAssignee(issueNumber) {
  try {
    runOrThrow('gh', ['issue', 'edit', issueNumber, '--add-assignee', '@me'])
    console.log(`#${issueNumber} の担当者に自分を足しました`)
  } catch (error) {
    console.warn(`担当者に自分を足せませんでした: ${toSingleLine(error.message)}`)
  }
}

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
 * 今いるリポジトリを `owner/repo` で引く。
 *
 * @returns {string} 今いるリポジトリ
 * @throws {TechnicalError} gh が失敗したとき（未ログイン・git の外・ネットワーク断など）
 */
function readCurrentRepository() {
  const { nameWithOwner } = runJson('gh', ['repo', 'view', '--json', 'nameWithOwner'])
  if (!nameWithOwner) throw new TechnicalError('gh repo view の出力に nameWithOwner がありません')
  return nameWithOwner
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
 * @returns {string} 警告として出す1行（原因のメッセージが複数行でも、空白でつないで1行にする）
 */
function describeMoveFailure(error) {
  const reason = toSingleLine(error.message)
  if (MISSING_SCOPE_PATTERN.test(reason)) {
    return `ボードを操作する権限がありません。\`gh auth refresh -s project\` で許可してください: ${reason}`
  }
  return `カードを動かせませんでした: ${reason}`
}

/**
 * 複数行のメッセージを、空白でつないで1行にする。警告を1行に収めるためである。
 *
 * @param {string} message 失敗の原因のメッセージ（gh の標準エラー出力を含み、複数行になりうる）
 * @returns {string} 1行にしたメッセージ
 */
function toSingleLine(message) {
  return message.replace(/\s*\n\s*/g, ' ').trim()
}

try {
  await runCli()
} catch (error) {
  console.warn(describeMoveFailure(error))
}
