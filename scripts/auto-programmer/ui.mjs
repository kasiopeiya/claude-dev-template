// 責務: auto-programmer の画面出力を1か所に集める。追記する行には時刻・レベル記号・色を付け、
//   待っている間の状況はステータス行として出し、子プロセスの出力（claude セッション・失敗した npm ci）は行頭に罫線を付け、
//   ステータス行を避けて中継する。
//
// 設計意図（WHY）:
// - 素の console.log は、いつ出た行か・正常なのか異常なのかを画面に残さない。無人で回すツールでは、
//   起動した人間が異常に気づけないまま、着手待ちのカードを空振りで使い切る（Issue #780）。
// - 色は Node 標準の util.styleText に任せる。NO_COLOR や非 TTY では自動で色が落ち、npm 依存も増えない。
// - 色は行全体でなく、時刻を薄く・レベル記号を色付きにする。本文まで色を付けるのは警告と異常だけにし、
//   見落とせない行だけが目立つようにする。
// - 警告と異常は stderr へ出す。画面をファイルへ流したときに、異常だけを分けて拾える。
// - 行の組み立ては uiFormat.mjs の純粋関数に寄せ、ここは「どちらのストリームへどう書くか（色・その場更新）」
//   だけを持つ。

import { styleText } from 'node:util'

import {
  CHILD_OUTPUT_GUTTER,
  buildIssueBannerText,
  buildMessageLines,
  buildStatusLineText,
  formatClockTime,
  prefixChunkLines
} from './uiFormat.mjs'

// ステータス行の TTY 判定・消去・書き込みは、同じストリームを見ないと消し残しが起きる
const STATUS_LINE_STREAM = process.stdout
const ERASE_CURRENT_LINE = '\r\x1b[K'

// 行の種類ごとの見た目と行き先。symbolStyle・textStyle は util.styleText に渡す書式（レベル記号用・本文用。
// textStyle が null なら本文は素のまま）
const LINE_STYLES = {
  info: { symbol: 'ℹ', symbolStyle: 'cyan', textStyle: null, stream: process.stdout },
  banner: { symbol: 'ℹ', symbolStyle: 'cyan', textStyle: 'bold', stream: process.stdout },
  success: { symbol: '✓', symbolStyle: 'green', textStyle: null, stream: process.stdout },
  warning: { symbol: '⚠', symbolStyle: 'yellow', textStyle: 'yellow', stream: process.stderr },
  error: { symbol: '✗', symbolStyle: 'red', textStyle: 'red', stream: process.stderr },
  status: { symbol: '⏳', symbolStyle: 'cyan', textStyle: null, stream: STATUS_LINE_STREAM }
}

const LINE_FEED_BYTE = 0x0a

// TTY でその場更新中のステータス行の内容（無ければ null）。自前の追記はどれも writeLines を、claude セッションの
// 出力は relayChildProcessOutput を通るので、どちらも先に消せば、ステータス行の末尾へ連結されずに済む。
// 端末へ直結する同期の子（preflight の clone）は、自前の追記の後に走らせることで守っている。
// 内容（本文と記号）を持つのは、子の出力を中継した後に同じ行を引き直すため
/** @type {{ message: string, symbol: string } | null} */
let activeStatusLine = null

// 中継した子の出力が改行で終わっていないストリームの名前。途中の行の上でステータス行を書くと、行頭へ戻って
// 消すときにその行ごと消える。自前の行を書くときは改行を足して、子の行の末尾へ連結させない。
// ストリームごとに持つのは、stdout と stderr を別々の先へ流したときに、片方の状態で他方を判断しないため
const midLineRelayedStreamNames = new Set()

/**
 * メッセージを1行以上の行にして書き出す。改行を含むメッセージも、行ごとに時刻とレベル記号が付く。
 *
 * @param {'info' | 'banner' | 'success' | 'warning' | 'error' | 'status'} kind 行の種類
 * @param {string} message 出す内容
 * @returns {void}
 */
function writeLines(kind, message) {
  clearStatusLine()
  closeRelayedOutputLines()
  const { symbol, symbolStyle, textStyle, stream } = LINE_STYLES[kind]
  const lines = buildMessageLines({
    ...buildStyledLinePrefix({ symbol, symbolStyle, stream }),
    message,
    styleLineText: textStyle ? (text) => styleText(textStyle, text, { stream }) : undefined
  })
  for (const line of lines) stream.write(`${line}\n`)
}

/**
 * 行頭の時刻とレベル記号に色を付ける。時刻は薄く、レベル記号は種類の色にする。
 *
 * @param {{ symbol: string, symbolStyle: string, stream: NodeJS.WriteStream }} params レベル記号・その書式・書き出す先（色を付けてよいかの判定に使う）
 * @returns {{ clockTime: string, symbol: string }} 色を付けた時刻とレベル記号
 */
function buildStyledLinePrefix({ symbol, symbolStyle, stream }) {
  return {
    clockTime: styleText('dim', formatClockTime(new Date()), { stream }),
    symbol: styleText(symbolStyle, symbol, { stream })
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
  if (activeStatusLine === null) return
  STATUS_LINE_STREAM.write(ERASE_CURRENT_LINE)
  activeStatusLine = null
}

/**
 * 中継した子の出力が行の途中で終わっているストリームへ改行を足し、次の行を行頭から書けるようにする。
 *
 * @returns {void}
 */
function closeRelayedOutputLines() {
  for (const streamName of midLineRelayedStreamNames) process[streamName].write('\n')
  midLineRelayedStreamNames.clear()
}

/**
 * ステータス行を書く端末で、中継した子の出力が行の途中になっているか。stderr は TTY のときだけ、
 * ステータス行と同じ端末に出ているとみなす。
 *
 * @returns {boolean} true なら行の途中
 */
function isStatusLineTerminalMidLine() {
  if (midLineRelayedStreamNames.has('stdout')) return true
  return midLineRelayedStreamNames.has('stderr') && process.stderr.isTTY === true
}

/**
 * 待っている間の状況を出す。TTY ではその場を書き換え（中継した子の出力が行の途中で終わっているときは
 * 何も出さない）、非TTY では時刻・レベル記号付きの1行として追記する（追記だけになる非TTY では、
 * この行自体が生存確認を兼ねる）。
 *
 * @param {string} message 出す内容（1行想定）
 * @param {{ symbol?: string }} [options] TTY のその場更新で、既定の ⏳ の代わりに出す記号（スピナーなど）。非TTY の追記には使わない
 * @returns {void}
 */
export function showStatusLine(message, { symbol = LINE_STYLES.status.symbol } = {}) {
  if (!isStdoutInteractiveTerminal()) {
    writeLines('status', message)
    return
  }
  // 子の出力が行の途中なら書かない。次の呼び出し（1秒ごとの経過表示など）で、行が閉じてから出る
  if (isStatusLineTerminalMidLine()) return
  const line = buildStatusLineText({
    ...buildStyledLinePrefix({
      symbol,
      symbolStyle: LINE_STYLES.status.symbolStyle,
      stream: STATUS_LINE_STREAM
    }),
    message
  })
  STATUS_LINE_STREAM.write(`${ERASE_CURRENT_LINE}${line}`)
  activeStatusLine = { message, symbol }
}

/**
 * 子プロセスの出力を、各行の頭に罫線を付けて端末へ中継する。罫線以外の内容には手を加えない。
 * その場更新中のステータス行があれば、消してから書き、子の出力が改行で終わっていれば同じ内容で
 * 引き直す（行の途中で終わったときは、行が閉じるまで引き直さない）。
 *
 * @param {'stdout' | 'stderr'} streamName 子のどちらのストリームから来たか（親の同じ名前のストリームへ書く）
 * @param {Buffer} chunk 子が書いた内容
 * @returns {void}
 */
export function relayChildProcessOutput(streamName, chunk) {
  if (chunk.length === 0) return
  const interruptedStatusLine = activeStatusLine
  clearStatusLine()
  closeOtherRelayedStreamOnSharedTerminal(streamName)
  const stream = process[streamName]
  stream.write(
    prefixChunkLines({
      chunk,
      prefix: styleText('dim', CHILD_OUTPUT_GUTTER, { stream }),
      isAtLineStart: !midLineRelayedStreamNames.has(streamName)
    })
  )
  if (chunk.at(-1) === LINE_FEED_BYTE) midLineRelayedStreamNames.delete(streamName)
  else midLineRelayedStreamNames.add(streamName)
  if (interruptedStatusLine !== null) {
    showStatusLine(interruptedStatusLine.message, { symbol: interruptedStatusLine.symbol })
  }
}

/**
 * 同じ端末に出ている他方のストリームへ中継した子の出力が行の途中なら、改行を足して閉じる。
 * 閉じないと、こちらのストリームの罫線が画面上の行の途中に入り、他方の続きは行頭なのに罫線を欠く。
 * 同じ端末かは、stdout と stderr がどちらも TTY かで判定する（`2>&1` でファイルへ流したときは見分けられない）。
 *
 * @param {'stdout' | 'stderr'} streamName これから中継するストリームの名前
 * @returns {void}
 */
function closeOtherRelayedStreamOnSharedTerminal(streamName) {
  const otherStreamName = streamName === 'stdout' ? 'stderr' : 'stdout'
  if (!midLineRelayedStreamNames.has(otherStreamName)) return
  if (process.stdout.isTTY !== true || process.stderr.isTTY !== true) return
  process[otherStreamName].write('\n')
  midLineRelayedStreamNames.delete(otherStreamName)
}

/**
 * 間引いて追記するステータス行を作る。TTY は呼ばれるたびに showStatusLine へ渡し、非TTY は `minAppendIntervalMs`
 * 未満の間隔では追記しない（間引かないと、ポーリング間隔の短い場面でログが溢れる）。
 * 呼ぶたびに新しい間引き区間を始めたい場面（CI の run を待つループなど）では、呼び出し側で
 * そのたびに作り直す。
 *
 * TTY のその場更新だけ見た目を変えたいときは、`liveMessage` と `symbol` を渡す（非TTY の追記は `message` のまま）。
 * プログレスバーのような毎秒変わる見た目を、追記するログに残さないため。
 *
 * @param {{ minAppendIntervalMs?: number }} [params] 非TTY で追記する最小間隔（省略時は毎回追記する）
 * @returns {(message: string, liveOptions?: { liveMessage?: string, symbol?: string }) => void} 呼ぶたびに状況を出す関数
 */
export function createThrottledStatusLine({ minAppendIntervalMs = 0 } = {}) {
  let lastAppendedAt = 0
  return (message, { liveMessage = message, symbol } = {}) => {
    if (isStdoutInteractiveTerminal()) {
      showStatusLine(liveMessage, { symbol })
      return
    }
    const now = Date.now()
    if (now - lastAppendedAt < minAppendIntervalMs) return
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
 * @param {{ issueNumber: number, title: string, branchName: string }} issue 対象 Issue の番号・タイトルと、作るトピックブランチ名
 * @returns {void}
 */
export function showIssueBanner({ issueNumber, title, branchName }) {
  // 先に消さずに '\n' を書くと、その場更新中のステータス行が改行の上に取り残される
  clearStatusLine()
  closeRelayedOutputLines()
  LINE_STYLES.banner.stream.write('\n')
  writeLines('banner', buildIssueBannerText({ issueNumber, title, branchName }))
}
