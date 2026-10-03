// 責務: 画面へ出す1行を組み立てる純粋関数だけを置く。端末への書き出しと色付けは ui.mjs が持つ。
//
// 設計意図（WHY）:
// - import を1つも持たない形に保つ。時刻の整形・所要時間の言い回し・行の組み立ては、端末もプロセスも
//   要らずに確かめられる。auto-programmer でテストを書くのはこの形のファイルだけである（unit-test-policy）。
// - 複数行のメッセージは行ごとに分けて返す。外部コマンドの標準エラー出力をそのまま載せると、時刻も
//   レベル記号も無い行が画面に混じり、どこからが1件の話なのかを人間が追えなくなる。
// - 子プロセスの出力は、各行の頭に時刻の幅だけ空けた罫線を差し込む。自前の行と同じ見た目で混ざると、
//   どこが auto-programmer 自身の話かを目で追えない（Issue #848）。
// - 罫線・バー・スピナーなど、このファイルが組み立てる記号は WGL4（Windows の標準等幅フォント Consolas・Lucida Console が持つ文字集合）から選ぶ。
//   Windows の Git Bash でも使うので、外れた記号は豆腐（□）になるか別フォントに置き換わって幅がずれる。
//   罫線・ブロック（│ ═ █ ░）は East Asian Width が「曖昧」で、端末によって2桁に描かれるので、
//   幅を揃える計算には使わない。
// - 表示幅は依存ライブラリを使わず、ここで数える。数える対象は自前の項目名だけなので、全角の主な範囲で足りる。

const MILLISECONDS_PER_SECOND = 1000
const SECONDS_PER_MINUTE = 60
const MINUTES_PER_HOUR = 60

// formatClockTime が返す `HH:MM:SS` の幅
const CLOCK_TIME_WIDTH = formatClockTime(new Date(0)).length

// 子プロセスの出力の各行頭に差し込む印。時刻と空白の幅だけ空け、自前の行のレベル記号と同じ桁に罫線を置く
export const CHILD_OUTPUT_GUTTER = `${' '.repeat(CLOCK_TIME_WIDTH + 1)}│ `

const LINE_FEED_BYTE = 0x0a

// 進み具合のバーのマス数。1マスの長さは上限÷マス数（上限60分なら3分）で、少ないと塗られるまで動かなく見える。
// 曖昧幅の文字が2桁で描かれても、ステータス行が80桁に収まる上限は20（1行が約77桁。30だと約97桁で折り返す）
const PROGRESS_BAR_CELLS = 20

// 待っている間に回すスピナーの絵柄。点字のスピナーは WGL4 に無いので ASCII にする
const SPINNER_FRAMES = ['|', '/', '-', '\\']

// 区切りバナーで Issue 番号の後ろに続ける二重罫線の長さ
const BANNER_RULE_LENGTH = 30

// 区切りバナーでタイトルとブランチ名を字下げする幅
const BANNER_INDENT = '   '

// 表示幅が2桁になる文字の範囲（East Asian Width が W・F の主なもの）
const WIDE_CODE_POINT_RANGES = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x20000, 0x3fffd]
]

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
  const totalSeconds = toWholeSeconds(milliseconds)
  const totalMinutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE)
  const seconds = totalSeconds % SECONDS_PER_MINUTE
  const minutes = totalMinutes % MINUTES_PER_HOUR
  const hours = Math.floor(totalMinutes / MINUTES_PER_HOUR)

  if (hours > 0) return `${hours}時間${minutes}分${seconds}秒`
  if (minutes > 0) return `${minutes}分${seconds}秒`
  return `${seconds}秒`
}

/**
 * 経過時間を表示用の整数秒にする。所要時間・`M:SS`・スピナーが同じ瞬間に秒を進めるよう、丸め方を1か所に持つ。
 *
 * @param {number} milliseconds 経過時間（ミリ秒）
 * @returns {number} 四捨五入した秒数（負の値は 0）
 */
function toWholeSeconds(milliseconds) {
  return Math.max(0, Math.round(milliseconds / MILLISECONDS_PER_SECOND))
}

/**
 * 経過時間を `M:SS` にする。桁の揃った短い形で、その場更新する行の幅を揺らさない。負の値は 0 秒として扱う。
 *
 * @param {number} milliseconds 経過時間（ミリ秒）
 * @returns {string} `M:SS`（例: `2:31`・`60:00`。60分を超えても時間に繰り上げない）
 */
function formatMinutesSeconds(milliseconds) {
  const totalSeconds = toWholeSeconds(milliseconds)
  const minutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE)
  const seconds = totalSeconds % SECONDS_PER_MINUTE
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/**
 * メッセージを、どの行にも時刻とレベル記号が付いた形に組み立てる。
 *
 * 時刻とレベル記号は「この行は auto-programmer 自身の出力である」という目印なので、外から混ざった
 * 制御文字がそれを上書き・消去できないよう落とす。本文の色付けは制御文字を落とした後に掛けるので、
 * 色の制御文字は残る。
 *
 * @param {{ clockTime: string, symbol: string, message: string, styleLineText?: (text: string) => string }} params 時刻・レベル記号・出す内容（改行を含んでもよい）・各行の本文に掛ける色付け（省略時はそのまま）
 * @returns {string[]} 書き出す行（メッセージが空でも1行返す）
 */
export function buildMessageLines({ clockTime, symbol, message, styleLineText = (text) => text }) {
  return String(message)
    .split('\n')
    .map(
      (line) =>
        `${clockTime} ${symbol} ${styleLineText(line.replace(CONTROL_CHARACTER_PATTERN, ''))}`
    )
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
 * claude セッション中の、その場更新するステータス行の本文を作る（TTY 専用）。
 * 経過は上限と同じ桁数に揃え、行の幅が揺れないようにする。
 *
 * @param {{ elapsedMs: number, limitMs: number }} params 経過時間と打ち切るまでの上限（どちらもミリ秒）
 * @returns {string} 例: `実行中  [████████░░░░░░░░░░░░]  24:31 / 60:00`
 */
export function buildSessionProgressText({ elapsedMs, limitMs }) {
  const limitText = formatMinutesSeconds(limitMs)
  const elapsedText = formatMinutesSeconds(elapsedMs).padStart(limitText.length)
  return `実行中  ${buildProgressBar(limitMs > 0 ? elapsedMs / limitMs : 0)}  ${elapsedText} / ${limitText}`
}

/**
 * 進み具合を、マスを塗ったバーにする。
 *
 * @param {number} ratio 進み具合（0〜1。範囲外は端に寄せる）
 * @returns {string} 例: `[████░░░░░░░░░░░░░░░░]`
 */
function buildProgressBar(ratio) {
  const filledCells = Math.min(
    PROGRESS_BAR_CELLS,
    Math.max(0, Math.floor(ratio * PROGRESS_BAR_CELLS))
  )
  return `[${'█'.repeat(filledCells)}${'░'.repeat(PROGRESS_BAR_CELLS - filledCells)}]`
}

/**
 * 経過時間に応じたスピナーの絵柄を選ぶ。経過の秒数で選ぶので、1秒ごとに呼ぶと1つずつ進む
 * （呼ぶ間隔が4秒の倍数だと、毎回同じ絵柄になって止まって見える）。
 *
 * @param {number} elapsedMs 経過時間（ミリ秒）
 * @returns {string} スピナーの絵柄1文字
 */
export function pickSpinnerFrame(elapsedMs) {
  return SPINNER_FRAMES[toWholeSeconds(elapsedMs) % SPINNER_FRAMES.length]
}

/**
 * 子プロセスの出力の各行頭に印を差し込む。
 *
 * 差し込むのは改行バイトの直後と、行頭から書き始めるときだけにする。改行バイトは UTF-8 の多バイト文字の
 * 途中に現れないので、チャンクの境目で文字を割らない。末尾の改行の直後には差し込まない（次の行が来るかは、
 * 次のチャンクまで分からない）。
 *
 * @param {{ chunk: Buffer, prefix: string, isAtLineStart: boolean }} params 子が書いた内容・差し込む印・このチャンクが行頭から始まるか
 * @returns {Buffer} 印を差し込んだ内容
 */
export function prefixChunkLines({ chunk, prefix, isAtLineStart }) {
  if (chunk.length === 0) return chunk
  const prefixBytes = Buffer.from(prefix)
  const parts = isAtLineStart ? [prefixBytes] : []
  let lineStart = 0
  for (let index = 0; index < chunk.length; index++) {
    if (chunk[index] !== LINE_FEED_BYTE) continue
    parts.push(chunk.subarray(lineStart, index + 1))
    lineStart = index + 1
    if (lineStart < chunk.length) parts.push(prefixBytes)
  }
  parts.push(chunk.subarray(lineStart))
  return Buffer.concat(parts)
}

/**
 * Issue 1件の区切りバナーの文字列を作る。二重罫線の行の下に、字下げしたタイトルとブランチ名を置く。
 *
 * @param {{ issueNumber: number, title: string, branchName: string }} issue 対象 Issue の番号・タイトルと、作るトピックブランチ名
 * @returns {string} 区切りバナー（3行）
 */
export function buildIssueBannerText({ issueNumber, title, branchName }) {
  return [
    `══ #${issueNumber} ${'═'.repeat(BANNER_RULE_LENGTH)}`,
    `${BANNER_INDENT}${title}`,
    `${BANNER_INDENT}ブランチ: ${branchName}`
  ].join('\n')
}

/**
 * 端末での表示幅を数える。CJK・ハングル・全角英数など主な全角の文字は2桁、それ以外は1桁とみなす。
 * 絵文字など、この範囲に無い全角の文字と曖昧幅の文字も1桁に数えるので、揃える対象に使わない。
 *
 * @param {string} text 数える文字列
 * @returns {number} 表示幅
 */
function measureDisplayWidth(text) {
  let width = 0
  for (const character of String(text)) {
    const codePoint = character.codePointAt(0)
    const isWide = WIDE_CODE_POINT_RANGES.some(
      ([first, last]) => codePoint >= first && codePoint <= last
    )
    width += isWide ? 2 : 1
  }
  return width
}

/**
 * 項目名と値の組を、値が同じ桁から始まる行にする。項目名の幅は表示幅で数える。
 *
 * @param {{ label: string, value: string }[]} entries 項目名と値の組（並び順のまま行にする）
 * @returns {string[]} 例: `['CI    success', '記録  ~/runs.jsonl']`
 */
export function alignLabeledValues(entries) {
  const labelWidth = Math.max(0, ...entries.map(({ label }) => measureDisplayWidth(label)))
  return entries.map(
    ({ label, value }) => `${label}${' '.repeat(labelWidth - measureDisplayWidth(label))}  ${value}`
  )
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
