// 責務: auto-programmer 自身の画面出力を1か所に集める。追記する行には時刻・レベル記号・色を付け、
//   待っている間の状況はステータス行として出す。
//
// 設計意図（WHY）:
// - 素の console.log は、いつ出た行か・正常なのか異常なのかを画面に残さない。無人で回すツールでは、
//   起動した人間が異常に気づけないまま、着手待ちのカードを空振りで使い切る（Issue #780）。
// - 色は Node 標準の util.styleText に任せる。NO_COLOR や非 TTY では自動で色が落ち、npm 依存も増えない。
// - 警告と異常は stderr へ出す。画面をファイルへ流したときに、異常だけを分けて拾える。
// - 行の組み立ては uiFormat.mjs の純粋関数に寄せ、ここは「どちらのストリームへどう書くか（色・その場更新）」
//   だけを持つ。

import { styleText } from 'node:util'

import {
  buildIssueBannerText,
  buildMessageLines,
  buildStatusLineText,
  formatClockTime
} from './uiFormat.mjs'

// ステータス行の TTY 判定・消去・書き込みは、同じストリームを見ないと消し残しが起きる
const STATUS_LINE_STREAM = process.stdout
const ERASE_CURRENT_LINE = '\r\x1b[K'

// 行の種類ごとの見た目と行き先
const LINE_STYLES = {
  info: { symbol: 'ℹ', textStyle: null, stream: process.stdout },
  banner: { symbol: 'ℹ', textStyle: 'bold', stream: process.stdout },
  success: { symbol: '✓', textStyle: 'green', stream: process.stdout },
  warning: { symbol: '⚠', textStyle: 'yellow', stream: process.stderr },
  error: { symbol: '✗', textStyle: 'red', stream: process.stderr },
  status: { symbol: '⏳', textStyle: null, stream: STATUS_LINE_STREAM }
}

// TTY でその場更新中のステータス行が残っているか。自前の追記はどれも writeLines を通るので、
// ここで先に消せば、追記と、追記の後に走る子プロセス（claude セッションなど）の出力が
// ステータス行の末尾へ連結されずに済む
let hasActiveStatusLine = false

/**
 * メッセージを1行以上の行にして書き出す。改行を含むメッセージも、行ごとに時刻とレベル記号が付く。
 *
 * @param {'info' | 'banner' | 'success' | 'warning' | 'error' | 'status'} kind 行の種類
 * @param {string} message 出す内容
 * @returns {void}
 */
function writeLines(kind, message) {
  clearStatusLine()
  const { symbol, textStyle, stream } = LINE_STYLES[kind]
  const lines = buildMessageLines({ clockTime: formatClockTime(new Date()), symbol, message })
  for (const line of lines) {
    stream.write(`${textStyle ? styleText(textStyle, line, { stream }) : line}\n`)
  }
}

/**
 * 標準出力が人間の対話的な端末に直接出ているか。`tee`・ファイルへのリダイレクト・CI のログでは false。
 * ステータス行をその場更新してよいかの判定に使う。
 *
 * @returns {boolean} true なら TTY
 */
function isStdoutInteractiveTerminal() {
  return STATUS_LINE_STREAM.isTTY === true
}

/**
 * TTY でその場更新中のステータス行があれば消す。書く前に必ずこれを呼ぶ。
 *
 * @returns {void}
 */
function clearStatusLine() {
  if (!hasActiveStatusLine) return
  STATUS_LINE_STREAM.write(ERASE_CURRENT_LINE)
  hasActiveStatusLine = false
}

/**
 * 待っている間の状況を出す。TTY ではその場を書き換え、非TTY では時刻・レベル記号付きの1行として
 * 追記する（追記だけになる非TTY では、この行自体が生存確認を兼ねる）。
 *
 * @param {string} message 出す内容（1行想定）
 * @returns {void}
 */
export function showStatusLine(message) {
  if (!isStdoutInteractiveTerminal()) {
    writeLines('status', message)
    return
  }
  const line = buildStatusLineText({
    clockTime: formatClockTime(new Date()),
    symbol: LINE_STYLES.status.symbol,
    message
  })
  STATUS_LINE_STREAM.write(`${ERASE_CURRENT_LINE}${line}`)
  hasActiveStatusLine = true
}

/**
 * 間引いて追記するステータス行を作る。TTY は毎回その場更新し、非TTY は `minAppendIntervalMs`
 * 未満の間隔では追記しない（間引かないと、ポーリング間隔の短い場面でログが溢れる）。
 * 呼ぶたびに新しい間引き区間を始めたい場面（CI の run を待つループなど）では、呼び出し側で
 * そのたびに作り直す。
 *
 * @param {{ minAppendIntervalMs?: number }} [params] 非TTY で追記する最小間隔（省略時は毎回追記する）
 * @returns {(message: string) => void} 呼ぶたびに状況を出す関数
 */
export function createThrottledStatusLine({ minAppendIntervalMs = 0 } = {}) {
  let lastAppendedAt = 0
  return (message) => {
    const now = Date.now()
    if (!isStdoutInteractiveTerminal() && now - lastAppendedAt < minAppendIntervalMs) return
    lastAppendedAt = now
    showStatusLine(message)
  }
}

/**
 * 進行中の出来事を伝える。
 *
 * @param {string} message 出す内容
 * @returns {void}
 */
export function showInfo(message) {
  writeLines('info', message)
}

/**
 * うまくいったことを伝える。
 *
 * @param {string} message 出す内容
 * @returns {void}
 */
export function showSuccess(message) {
  writeLines('success', message)
}

/**
 * 処理は続くが人間に見てほしいことを、stderr へ伝える。
 *
 * @param {string} message 出す内容
 * @returns {void}
 */
export function showWarning(message) {
  writeLines('warning', message)
}

/**
 * 異常を stderr へ伝える。
 *
 * @param {string} message 出す内容
 * @returns {void}
 */
export function showError(message) {
  writeLines('error', message)
}

/**
 * Issue 1件の始まりを区切りバナーで示す。claude のセッションが流す出力との境目を作るためのもの。
 *
 * @param {{ issueNumber: number, title: string }} issue 対象 Issue の番号とタイトル
 * @returns {void}
 */
export function showIssueBanner({ issueNumber, title }) {
  // 先に消さずに '\n' を書くと、その場更新中のステータス行が改行の上に取り残される
  clearStatusLine()
  LINE_STYLES.banner.stream.write('\n')
  writeLines('banner', buildIssueBannerText({ issueNumber, title }))
}
