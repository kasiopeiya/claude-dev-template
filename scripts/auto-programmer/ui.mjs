// 責務: auto-programmer 自身の画面出力を1か所に集め、どの行にも時刻・レベル記号・色を付けて書き出す。
//
// 設計意図（WHY）:
// - 素の console.log は、いつ出た行か・正常なのか異常なのかを画面に残さない。無人で回すツールでは、
//   起動した人間が異常に気づけないまま、着手待ちのカードを空振りで使い切る（Issue #780）。
// - 色は Node 標準の util.styleText に任せる。NO_COLOR や非 TTY では自動で色が落ち、npm 依存も増えない。
// - 警告と異常は stderr へ出す。画面をファイルへ流したときに、異常だけを分けて拾える。
// - 行の組み立ては uiFormat.mjs の純粋関数に寄せ、ここは「どの色でどちらのストリームへ書くか」だけを持つ。

import { styleText } from 'node:util'

import { buildIssueBannerText, buildMessageLines, formatClockTime } from './uiFormat.mjs'

// 行の種類ごとの見た目と行き先
const LINE_STYLES = {
  info: { symbol: 'ℹ', textStyle: null, stream: process.stdout },
  banner: { symbol: 'ℹ', textStyle: 'bold', stream: process.stdout },
  success: { symbol: '✓', textStyle: 'green', stream: process.stdout },
  warning: { symbol: '⚠', textStyle: 'yellow', stream: process.stderr },
  error: { symbol: '✗', textStyle: 'red', stream: process.stderr }
}

/**
 * メッセージを1行以上の行にして書き出す。改行を含むメッセージも、行ごとに時刻とレベル記号が付く。
 *
 * @param {'info' | 'banner' | 'success' | 'warning' | 'error'} kind 行の種類
 * @param {string} message 出す内容
 * @returns {void}
 */
function writeLines(kind, message) {
  const { symbol, textStyle, stream } = LINE_STYLES[kind]
  const lines = buildMessageLines({ clockTime: formatClockTime(new Date()), symbol, message })
  for (const line of lines) {
    stream.write(`${textStyle ? styleText(textStyle, line, { stream }) : line}\n`)
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
  LINE_STYLES.banner.stream.write('\n')
  writeLines('banner', buildIssueBannerText({ issueNumber, title }))
}
