// 責務: 画面へ出す1行を組み立てる純粋関数だけを置く。端末への書き出しと色付けは ui.mjs が持つ。
//
// 設計意図（WHY）:
// - import を1つも持たない形に保つ。時刻の整形・所要時間の言い回し・行の組み立ては、端末もプロセスも
//   要らずに確かめられる。auto-programmer でテストを書くのはこの形のファイルだけである（unit-test-policy）。
// - 複数行のメッセージは行ごとに分けて返す。外部コマンドの標準エラー出力をそのまま載せると、時刻も
//   レベル記号も無い行が画面に混じり、どこからが1件の話なのかを人間が追えなくなる。

const MILLISECONDS_PER_SECOND = 1000
const SECONDS_PER_MINUTE = 60
const MINUTES_PER_HOUR = 60

// 1行に畳んだ文字列の上限
const MAX_SINGLE_LINE_LENGTH = 200

// 上限を超えたときに先頭へ残す長さ。外部コマンドの失敗メッセージは「何を実行したか」が前、「なぜ失敗したか」が
// 後ろに来る。前は何のコマンドか分かるだけ残し、残りを後ろへ回して原因を必ず画面に出す
const SINGLE_LINE_HEAD_LENGTH = 60

// 端末の制御文字（CR・ESC など）。混じると行頭へ戻る・カーソルを動かすなどして、先頭に付けた時刻と
// レベル記号を上書き・消去できてしまう。タブと改行は含めない（改行は行の区切りとして先に分ける）。
// no-control-regex は制御文字の書き忘れ・打ち間違いを拾う規則で、ここは落とす対象として意図的に並べている
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u0008\u000B-\u001F\u007F]/g

/**
 * 時刻を `HH:MM:SS` にする（実行しているマシンのローカル時刻）。
 *
 * @param {Date} time 整形する時刻
 * @returns {string} `HH:MM:SS`
 */
export function formatClockTime(time) {
  const padToTwoDigits = (value) => String(value).padStart(2, '0')
  return [time.getHours(), time.getMinutes(), time.getSeconds()].map(padToTwoDigits).join(':')
}

/**
 * 所要時間を「12分30秒」の形にする。負の値は 0 秒として扱う。
 *
 * @param {number} milliseconds 所要時間（ミリ秒）
 * @returns {string} 人間が読む所要時間（例: `45秒`・`12分30秒`・`1時間3分5秒`）
 */
export function formatElapsedTime(milliseconds) {
  const totalSeconds = Math.max(0, Math.round(milliseconds / MILLISECONDS_PER_SECOND))
  const totalMinutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE)
  const seconds = totalSeconds % SECONDS_PER_MINUTE
  const minutes = totalMinutes % MINUTES_PER_HOUR
  const hours = Math.floor(totalMinutes / MINUTES_PER_HOUR)

  if (hours > 0) return `${hours}時間${minutes}分${seconds}秒`
  if (minutes > 0) return `${minutes}分${seconds}秒`
  return `${seconds}秒`
}

/**
 * メッセージを、どの行にも時刻とレベル記号が付いた形に組み立てる。
 *
 * 時刻とレベル記号は「この行は auto-programmer 自身の出力である」という目印なので、外から混ざった
 * 制御文字がそれを上書き・消去できないよう落とす。
 *
 * @param {{ clockTime: string, symbol: string, message: string }} params 時刻・レベル記号・出す内容（改行を含んでもよい）
 * @returns {string[]} 書き出す行（メッセージが空でも1行返す）
 */
export function buildMessageLines({ clockTime, symbol, message }) {
  return String(message)
    .split('\n')
    .map((line) => `${clockTime} ${symbol} ${line.replace(CONTROL_CHARACTER_PATTERN, '')}`)
}

/**
 * その場更新するステータス行の文字列を、他の行と同じ「時刻 記号 内容」の形に組み立てる。
 * 複数行には分けず、改行は空白へ畳む（その場更新は1行の中でしか成り立たない）。
 *
 * @param {{ clockTime: string, symbol: string, message: string }} params 時刻・記号・出す内容
 * @returns {string} `時刻 記号 メッセージ`（その場更新を壊す制御文字は落とす）
 */
export function buildStatusLineText({ clockTime, symbol, message }) {
  const singleLineMessage = String(message).replace(/\n/g, ' ')
  return `${clockTime} ${symbol} ${singleLineMessage.replace(CONTROL_CHARACTER_PATTERN, '')}`
}

/**
 * Issue 1件の区切りバナーの文字列を作る。
 *
 * @param {{ issueNumber: number, title: string }} issue 対象 Issue の番号とタイトル
 * @returns {string} 区切りバナー（例: `── #123 タイトル ──`）
 */
export function buildIssueBannerText({ issueNumber, title }) {
  return `── #${issueNumber} ${title} ──`
}

/**
 * 複数行になりうる文字列を、画面に出す1行に畳む。
 *
 * 外部コマンドの失敗メッセージは標準エラー出力を丸ごと抱えている。最初の行だけを採ると「gh が失敗した」
 * という外側しか残らず、原因（レートリミットなど）は後ろの行にあるので、中身のある行を順につなぐ。
 *
 * 上限を超えたら、後ろではなく真ん中を落とす。後ろを落とすと、長いコマンド行の後ろにある原因ごと消える。
 *
 * @param {string} text 畳む文字列
 * @returns {string} 1行に畳んだ文字列（上限を超えたら真ん中を `…` で落とす。どの行も空なら空文字）
 */
export function collapseToSingleLine(text) {
  const collapsed = String(text)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join(' / ')
  if (collapsed.length <= MAX_SINGLE_LINE_LENGTH) return collapsed

  const tailLength = MAX_SINGLE_LINE_LENGTH - SINGLE_LINE_HEAD_LENGTH
  return `${collapsed.slice(0, SINGLE_LINE_HEAD_LENGTH)}…${collapsed.slice(-tailLength)}`
}
