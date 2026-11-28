// 責務: stream-json で起動した claude セッションの標準出力を行ごとに読み、イベントをセッションごとの JSONL へ
//   追記し、画面には claude の文章だけを中継する。
//
// 設計意図（WHY）:
// - イベントを残すのは、遅い理由（どのツールを何回呼んだか）や使用制限の状態が、イベントの中にしか無いため（#2023）。
//   画面に出すのは文章だけにする。イベントをそのまま流すと、人間が読めない JSON で埋まる。
// - claude の JSON 出力形式は Anthropic が決め、黙って変わりうる。
//   形式が変わっても壊れ方を小さくするため、JSON として読めない行は捨てずに画面へそのまま流し、読めた行は
//   加工せずに残す。中身の名前に頼るのは、画面へ出す文章を選ぶところだけにする。
// - 失敗したセッションの理由（is_error の result）も画面に出す。無人実行で人間が最初に見るのは画面である。
// - 行の区切りはバイト列のまま探す。チャンクは行の途中でも、日本語の1文字の途中でも切れて届くので、
//   チャンクごとに文字列へ直すと文字が化ける。改行のバイトは UTF-8 の多バイト文字の中に現れない。
// - 記録に書けなくなったら、警告を1行出して記録だけを止める。記録は診断のためのもので、セッションは続けてよい。
//   出力の中継中に投げると捕まえる場所が無く、このツールごと落ちて claude だけが残る。

import { appendFileSync } from 'node:fs'

import { relayChildProcessOutput, showWarning } from './ui.mjs'

const LINE_FEED_BYTE = 0x0a

/**
 * claude セッションの出力の中継先を作る。標準出力は行ごとにイベントとして読み、標準エラー出力はそのまま画面へ流す。
 *
 * @param {{ eventLogFilePath: string }} params イベントを追記する JSONL のパス（置き場のディレクトリは呼び出し側が作っておく）
 * @returns {{ onOutput: (streamName: 'stdout' | 'stderr', chunk: Buffer) => void, flush: () => void }} 子の出力の中継先と、プロセスが終わった後に改行で終わっていない最後の行を処理する関数
 */
export function createSessionEventRelay({ eventLogFilePath }) {
  let pendingStdoutBytes = Buffer.alloc(0)
  let isEventLogWritable = true

  const appendEventLine = (line) => {
    if (!isEventLogWritable) return
    try {
      appendFileSync(eventLogFilePath, `${line}\n`)
    } catch (error) {
      isEventLogWritable = false
      showWarning(
        `イベントの記録を止めます（${eventLogFilePath}）: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  const handleStdoutLine = (lineBytes) => {
    const line = lineBytes.toString('utf8')
    const { sessionEvent, screenText } = readSessionEventLine(line)
    if (sessionEvent === null) {
      relayChildProcessOutput('stdout', Buffer.from(`${line}\n`))
      return
    }
    appendEventLine(line)
    if (screenText !== null)
      relayChildProcessOutput('stdout', Buffer.from(endWithLineFeed(screenText)))
  }

  return {
    onOutput: (streamName, chunk) => {
      if (streamName === 'stderr') {
        relayChildProcessOutput(streamName, chunk)
        return
      }
      pendingStdoutBytes = Buffer.concat([pendingStdoutBytes, chunk])
      let lineFeedIndex = pendingStdoutBytes.indexOf(LINE_FEED_BYTE)
      while (lineFeedIndex !== -1) {
        handleStdoutLine(pendingStdoutBytes.subarray(0, lineFeedIndex))
        pendingStdoutBytes = pendingStdoutBytes.subarray(lineFeedIndex + 1)
        lineFeedIndex = pendingStdoutBytes.indexOf(LINE_FEED_BYTE)
      }
    },
    flush: () => {
      if (pendingStdoutBytes.length === 0) return
      handleStdoutLine(pendingStdoutBytes)
      pendingStdoutBytes = Buffer.alloc(0)
    }
  }
}

/**
 * stream-json の1行を読み、記録するイベントと画面に流す文章に分ける。
 *
 * 画面に流すのは、`assistant` イベントの `message.content` のうち `type` が `text` の部分と、
 * 失敗を表す `result` イベント（`is_error` が true）の理由だけである。考えている途中（`thinking`）や
 * ツールの呼び出し（`tool_use`）、成功した `result`、ほかの種類のイベントは画面に出さない。
 *
 * @param {string} line 標準出力の1行（改行を含まない）
 * @returns {{ sessionEvent: Record<string, unknown> | null, screenText: string | null }} JSON のオブジェクトとして読めたイベント（読めなければ null）と、画面に流す文章（無ければ null）
 */
function readSessionEventLine(line) {
  const sessionEvent = parseSessionEvent(line)
  if (sessionEvent === null) return { sessionEvent: null, screenText: null }
  return {
    sessionEvent,
    screenText: pickAssistantText(sessionEvent) ?? pickFailedResultText(sessionEvent)
  }
}

/**
 * 1行を JSON のオブジェクトとして読む。
 *
 * @param {string} line 標準出力の1行
 * @returns {Record<string, unknown> | null} 読めたイベント（空行・JSON でない行・オブジェクトでない JSON なら null）
 */
function parseSessionEvent(line) {
  if (line.trim() === '') return null
  try {
    const parsed = JSON.parse(line)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * `assistant` イベントから文章の部分を取り出す。
 *
 * @param {Record<string, unknown>} sessionEvent イベント
 * @returns {string | null} 文章の部分をつないだもの（`assistant` でない・文章の部分が無いなら null）
 */
function pickAssistantText(sessionEvent) {
  if (sessionEvent.type !== 'assistant') return null
  const messageContent = /** @type {{ content?: unknown } | undefined} */ (sessionEvent.message)
    ?.content
  if (!Array.isArray(messageContent)) return null
  const texts = messageContent
    .filter(
      (contentBlock) => contentBlock?.type === 'text' && typeof contentBlock.text === 'string'
    )
    .map((contentBlock) => contentBlock.text)
  return texts.length === 0 ? null : texts.join('\n')
}

/**
 * 失敗を表す `result` イベントから、失敗の理由を取り出す。
 *
 * @param {Record<string, unknown>} sessionEvent イベント
 * @returns {string | null} 失敗の理由（`result` が文字列ならそれ、無ければ `subtype` を添えた定型文）。失敗の `result` でなければ null
 */
function pickFailedResultText(sessionEvent) {
  if (sessionEvent.type !== 'result' || sessionEvent.is_error !== true) return null
  if (typeof sessionEvent.result === 'string' && sessionEvent.result !== '') {
    return sessionEvent.result
  }
  return `セッションが失敗しました（${String(sessionEvent.subtype)}）`
}

/**
 * 文字列が改行で終わるようにする。終わらないまま中継すると、次に出す行が同じ行へ連結される。
 *
 * @param {string} text 画面に流す文章
 * @returns {string} 改行で終わる文章
 */
function endWithLineFeed(text) {
  return text.endsWith('\n') ? text : `${text}\n`
}
