// 責務: 実行記録（config.runLogPath）を読み、ブラウザで開く読むだけの画面として返す HTTP サーバーを担う。
//
// 設計意図（WHY）:
// - 記録は Issue 1件につき1行の JSON で、端末では項目が多すぎて読めない。どの Issue がどう終わったかを、一覧で見られるようにする。
// - 画面の形・文言・色は、人間が合意した見本（Issue #2028 のコメント）に合わせる。
// - 結果の分類は decideRunOutcome をそのまま使う。別に判定すると、端末の締め・読み上げと画面で結果が食い違う（Issue #780）。
// - HTML はサーバーで組み立て、記録の文字列はすべてエスケープしてから埋める。記録を JSON のまま <script> に埋めると、
//   タイトルに `</script>` が入った回でタグが閉じて、記録の文字列がスクリプトとして働く。
// - 開いている画面と絞り込みは URL のクエリに持たせる。読み直しても、人間が選んだ画面のまま残る。
// - 127.0.0.1 だけで待ち受け、Host が自分でない要求は断る。ほかのマシンからも、DNS リバインディングで
//   よそのページからも、記録を読ませない。

import { createServer } from 'node:http'

import { TechnicalError } from '../lib/errors.mjs'
import { config } from './config.mjs'
import { hasSessionSucceeded } from './claudeSession.mjs'
import { readRunRecords } from './runLog.mjs'
import { decideRunOutcome } from './runOutcome.mjs'
import { showError, showInfo } from './ui.mjs'
import {
  collapseToSingleLine,
  formatElapsedTime,
  formatErrorMessage,
  formatErrorWithStack
} from './uiFormat.mjs'

const LISTEN_HOST = '127.0.0.1'
const RELOAD_INTERVAL_SECONDS = 5
const EMPTY_VIEW_HTML = '<div class="card"><p class="empty">まだありません</p></div>'

// decideRunOutcome の戻り値ごとの、画面での語・印・色の組（見本の OUTCOMES と同じ）
const OUTCOME_DISPLAYS = {
  completed: { label: '完了', icon: '✓', className: 'st-completed' },
  'needs-human-attention': { label: '要確認', icon: '!', className: 'st-attention' },
  failed: { label: '失敗', icon: '✕', className: 'st-failed' },
  'handed-over-to-sub-issues': { label: '子へ引き継ぎ', icon: '→', className: 'st-handed' }
}

const PAGE_STYLE = `
:root {
  color-scheme: light;
  --page: #f6f6f4; --surface: #ffffff; --line: #e3e3df; --track: #ececea;
  --text: #191919; --text-2: #666666; --link: #1757ac;
  --good: #0aac23; --warning: #fbb315; --critical: #dc3c3d; --neutral: #8a8a86;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --page: #121212; --surface: #191919; --line: #333333; --track: #2a2a2a;
    --text: #efefef; --text-2: #9c9c9c; --link: #84b9f3;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--text);
  font: 15px/1.6 -apple-system, "Hiragino Sans", "Noto Sans JP", "Yu Gothic UI", sans-serif; }
.wrap { max-width: 1040px; margin: 0 auto; padding: 20px 16px 48px; }
header { display: flex; flex-wrap: wrap; gap: 12px 24px; align-items: center; justify-content: space-between; }
h1 { font-size: 20px; margin: 0; display: flex; align-items: center; gap: 10px; }
nav { display: flex; gap: 4px; margin: 20px 0 16px; border-bottom: 1px solid var(--line); }
nav a { color: var(--text-2); text-decoration: none; border-bottom: 2px solid transparent; padding: 8px 14px; }
nav a[aria-selected="true"] { color: var(--text); border-bottom-color: var(--text); font-weight: 600; }
.updated { font-size: 12px; color: var(--text-2); margin-left: auto; align-self: center; padding-right: 4px; font-variant-numeric: tabular-nums; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; }
.empty { padding: 16px 18px; color: var(--text-2); }
.chips { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.chips a { font-size: 13px; color: var(--text); text-decoration: none; background: var(--surface); border: 1px solid var(--line); border-radius: 999px; padding: 3px 12px; }
.chips a[aria-pressed="true"] { border-color: var(--text); font-weight: 600; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th { text-align: left; font-size: 12px; font-weight: 500; color: var(--text-2); padding: 10px 14px; border-bottom: 1px solid var(--line); white-space: nowrap; }
td { padding: 10px 14px; border-bottom: 1px solid var(--line); vertical-align: top; }
tr:last-child td { border-bottom: 0; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.status { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.status i { font-style: normal; width: 18px; height: 18px; border-radius: 50%; color: #fff; font-size: 12px; font-weight: 700; display: inline-grid; place-items: center; }
.st-completed i { background: var(--good); } .st-attention i { background: var(--warning); color: #191919; }
.st-failed i { background: var(--critical); } .st-handed i { background: var(--neutral); }
.sub { color: var(--text-2); font-size: 12px; }
.nowrap { white-space: nowrap; }
a { color: var(--link); }
@media (max-width: 640px) { .hide-s { display: none; } }
`

// 読み直しは、同じ URL を取り直して中身だけを差し替える（ページごと読み込み直すと、スクロールの位置が戻る）。
// 取り直せなかった回（サーバーが止まった・記録を読めず 500 を返した）は前の中身のまま残す。最終更新の時刻が止まるので、人間は古いと気づける
const RELOAD_SCRIPT = `
setInterval(async () => {
  try {
    const response = await fetch(location.href)
    if (!response.ok) return
    const nextDocument = new DOMParser().parseFromString(await response.text(), 'text/html')
    const nextApp = nextDocument.getElementById('app')
    if (nextApp) document.getElementById('app').replaceWith(nextApp)
  } catch {}
}, ${RELOAD_INTERVAL_SECONDS * 1000})
`

/**
 * 文字列を、HTML の本文と属性値のどちらに埋めてもタグとして働かない形にする。
 *
 * @param {unknown} text 埋める値（記録の値など）。文字列でなければ String() で文字列にしてから置き換える（null は 'null' になる）
 * @returns {string} `&`・`<`・`>`・`"`・`'` を文字参照にした文字列
 */
function escapeHtml(text) {
  const characterReferences = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }
  return String(text).replace(/[&<>"']/g, (character) => characterReferences[character])
}

// 記録に `isAllSessionsSucceeded` が無い古い行で、claude セッション1つの終わり方を残している項目の組
const SESSION_STATUS_FIELD_NAMES = [
  { exitCodeFieldName: 'issueCheckExitCode', signalFieldName: 'issueCheckSignal' },
  { exitCodeFieldName: 'autoDevExitCode', signalFieldName: 'autoDevSignal' },
  { exitCodeFieldName: 'ciFixExitCode', signalFieldName: 'ciFixSignal' },
  { exitCodeFieldName: 'conflictResolutionExitCode', signalFieldName: 'conflictResolutionSignal' },
  { exitCodeFieldName: 'exitCode', signalFieldName: 'signal' }
]

/**
 * 走らせた claude セッションがすべて正常終了したか（decideRunOutcome の第2引数）を、記録から読む。
 *
 * 記録に `isAllSessionsSucceeded` があれば、端末の締めが使った値なのでそのまま返す。無い古い行は、残っている
 * セッションの終わり方に hasSessionSucceeded を当てて導く。
 *
 * @param {Record<string, unknown>} record 実行記録の1行
 * @returns {boolean} セッションがすべて正常終了したなら true
 */
function readIsAllSessionsSucceeded(record) {
  if (typeof record.isAllSessionsSucceeded === 'boolean') return record.isAllSessionsSucceeded
  return SESSION_STATUS_FIELD_NAMES.filter(({ exitCodeFieldName }) =>
    Object.hasOwn(record, exitCodeFieldName)
  ).every(({ exitCodeFieldName, signalFieldName }) =>
    hasSessionSucceeded({
      exitCode: record[exitCodeFieldName],
      signal: record[signalFieldName] ?? null
    })
  )
}

/**
 * 一覧の Issue の下に小さく出す、止まった理由を決める。
 *
 * @param {Record<string, any>} record 実行記録の1行
 * @param {keyof typeof OUTCOME_DISPLAYS} runOutcome decideRunOutcome が決めた結果の分類
 * @returns {string} 止まった理由（出すものが無ければ空文字）
 */
function explainRunOutcome(record, runOutcome) {
  if (runOutcome === 'failed') return collapseToSingleLine(record.error)
  if (runOutcome === 'handed-over-to-sub-issues') {
    return `子の Issue を${record.subIssueHandover.putOnReadySubIssueNumbers.length}件、着手待ちに載せました`
  }
  if (runOutcome !== 'needs-human-attention') return ''
  if (record.reasonNotToImplement) return String(record.reasonNotToImplement)
  if (!readIsAllSessionsSucceeded(record)) return 'claude のセッションが失敗しました'
  return ''
}

/**
 * 記録の時刻を「11/28 14:07」の形（このマシンの時間帯）にする。
 *
 * @param {unknown} isoTime 記録の時刻（ISO 8601）
 * @returns {string} 人間が読む時刻（読めなければ `—`）
 */
function formatFinishedAt(isoTime) {
  const finishedAt = new Date(String(isoTime))
  if (Number.isNaN(finishedAt.getTime())) return '—'
  const padToTwoDigits = (timePart) => String(timePart).padStart(2, '0')
  const datePart = `${finishedAt.getMonth() + 1}/${finishedAt.getDate()}`
  return `${datePart} ${padToTwoDigits(finishedAt.getHours())}:${padToTwoDigits(finishedAt.getMinutes())}`
}

/**
 * 記録の始めと終わりの時刻から、所要時間を「12分30秒」の形にする（端末の締めと同じ表記）。
 *
 * @param {Record<string, unknown>} record 実行記録の1行
 * @returns {string} 所要時間（どちらかの時刻が読めなければ `—`）
 */
function formatRunElapsedTime(record) {
  const elapsedMs =
    Date.parse(String(record.finishedAt)) - Date.parse(String(record.sessionStartedAt))
  return Number.isNaN(elapsedMs) ? '—' : formatElapsedTime(elapsedMs)
}

/**
 * 記録の PR の URL を、一覧の PR の列に出すリンクにする。
 *
 * @param {unknown} pullRequestUrl 記録の `pullRequestUrl`
 * @returns {string} PR へのリンクの HTML（https の URL でなければ `—`）
 */
function renderPullRequestLink(pullRequestUrl) {
  if (typeof pullRequestUrl !== 'string' || !pullRequestUrl.startsWith('https://')) return '—'
  const pullRequestNumber = pullRequestUrl.match(/\/pull\/(\d+)/)?.[1]
  const linkText = pullRequestNumber ? `#${pullRequestNumber}` : 'PR'
  return `<a href="${escapeHtml(pullRequestUrl)}" title="${escapeHtml(pullRequestUrl)}">${linkText}</a>`
}

/**
 * 結果の分類を、印と語の組にする。
 *
 * @param {keyof typeof OUTCOME_DISPLAYS} runOutcome decideRunOutcome が決めた結果の分類
 * @returns {string} 結果の HTML
 */
function renderOutcomeStatus(runOutcome) {
  const { label, icon, className } = OUTCOME_DISPLAYS[runOutcome]
  return `<span class="status ${className}"><i aria-hidden="true">${icon}</i>${label}</span>`
}

/**
 * 実行記録の1行を、一覧の表の1行にする。
 *
 * @param {{ record: Record<string, any>, runOutcome: keyof typeof OUTCOME_DISPLAYS }} run 記録と結果の分類
 * @returns {string} 表の行の HTML
 */
function renderRunRow({ record, runOutcome }) {
  const reason = explainRunOutcome(record, runOutcome)
  const reasonHtml = reason ? `<div class="sub">${escapeHtml(reason)}</div>` : ''
  const ciText = record.isCiPassed ? '通過' : (record.ciOutcome ?? '—')
  return `
    <tr>
      <td>${renderOutcomeStatus(runOutcome)}</td>
      <td><b>#${escapeHtml(record.issueNumber)}</b> ${escapeHtml(record.issueTitle ?? '')}${reasonHtml}</td>
      <td class="hide-s sub nowrap">${formatFinishedAt(record.finishedAt)}</td>
      <td class="num">${formatRunElapsedTime(record)}</td>
      <td class="hide-s">${escapeHtml(ciText)}</td>
      <td>${renderPullRequestLink(record.pullRequestUrl)}</td>
    </tr>`
}

/**
 * 結果で絞り込むボタンを、件数つきで並べる。件数が0の分類は出さない（見本と同じ）。ただし、いま選んでいる分類は0件でも出す
 * （URL で選ばれた分類が0件のとき、何で絞り込んでいるかが画面から消えないように）。
 *
 * @param {{ runs: { runOutcome: string }[], selectedOutcome: string }} params 全部の回と、いま選んでいる絞り込み（`all` は全部）
 * @returns {string} ボタンを並べた HTML
 */
function renderOutcomeFilters({ runs, selectedOutcome }) {
  const choices = [
    { outcomeKey: 'all', label: 'すべて', count: runs.length },
    ...Object.entries(OUTCOME_DISPLAYS).map(([outcomeKey, { label }]) => ({
      outcomeKey,
      label,
      count: runs.filter((run) => run.runOutcome === outcomeKey).length
    }))
  ]
  return choices
    .filter(({ outcomeKey, count }) => count > 0 || outcomeKey === selectedOutcome)
    .map(
      ({ outcomeKey, label, count }) =>
        `<a href="?view=runs&amp;outcome=${outcomeKey}" aria-pressed="${outcomeKey === selectedOutcome}">${label} ${count}</a>`
    )
    .join('')
}

/**
 * 過去の回の一覧を組み立てる。新しい回を上に置く。
 *
 * 記録は回を終えた時に追記されるので、ファイルの後ろほど新しい。並べた別のプロセスの回も、終えた順に並ぶ。
 *
 * @param {string} selectedOutcome いま選んでいる絞り込み（`all` は全部）
 * @returns {string} 一覧の画面の HTML
 * @throws {Error} 記録ファイルがあるのに読めなかったとき（readRunRecords から伝わる）
 */
function renderRunsView(selectedOutcome) {
  const runs = readRunRecords()
    .reverse()
    .map((record) => ({
      record,
      runOutcome: decideRunOutcome(record, readIsAllSessionsSucceeded(record))
    }))
  if (runs.length === 0) return EMPTY_VIEW_HTML
  const shownRuns = runs.filter(
    (run) => selectedOutcome === 'all' || run.runOutcome === selectedOutcome
  )
  const runsHtml =
    shownRuns.length === 0
      ? '<p class="empty">該当する回はありません</p>'
      : `<table>
        <thead><tr><th>結果</th><th>Issue</th><th class="hide-s">終わった時刻</th><th class="num">所要時間</th><th class="hide-s">CI</th><th>PR</th></tr></thead>
        <tbody>${shownRuns.map(renderRunRow).join('')}</tbody>
      </table>`
  return `
    <div class="chips">${renderOutcomeFilters({ runs, selectedOutcome })}</div>
    <div class="card">${runsHtml}</div>`
}

/**
 * 画面の枠（見出し・タブ・最終更新の時刻）に、選んだ画面の中身を入れて、ページ全体にする。
 *
 * @param {{ view: 'now' | 'runs', viewHtml: string }} params 開いている画面と、その中身の HTML
 * @returns {string} ページ全体の HTML
 */
function renderPage({ view, viewHtml }) {
  const updatedAt = new Date().toLocaleTimeString('ja-JP')
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Auto Programmer</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<div class="wrap" id="app">
  <header><h1>Auto Programmer</h1></header>
  <nav role="tablist">
    <a role="tab" href="?view=now" aria-selected="${view === 'now'}">いまの状況</a>
    <a role="tab" href="?view=runs" aria-selected="${view === 'runs'}">過去の回</a>
    <span class="updated">最終更新 ${updatedAt}（${RELOAD_INTERVAL_SECONDS}秒ごとに読み直し）</span>
  </nav>
  <section>${viewHtml}</section>
</div>
<script>${RELOAD_SCRIPT}</script>
</body>
</html>`
}

/**
 * 要求の URL のクエリから、開く画面と絞り込みを読む。知らない値は既定（過去の回・すべて）に倒す。
 *
 * @param {URLSearchParams} query 要求の URL のクエリ
 * @returns {{ view: 'now' | 'runs', selectedOutcome: string }} 開く画面と、選んだ絞り込み
 */
function readPageQuery(query) {
  const outcome = query.get('outcome') ?? 'all'
  return {
    view: query.get('view') === 'now' ? 'now' : 'runs',
    selectedOutcome: Object.hasOwn(OUTCOME_DISPLAYS, outcome) ? outcome : 'all'
  }
}

/**
 * 要求1件に答える。`/` だけを返し、Host が自分でない要求と、読めない URL の要求は断る。
 *
 * @param {{ request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, port: number }} params 要求・応答と、待ち受けているポート
 * @returns {void}
 */
function respondToRequest({ request, response, port }) {
  const allowedHosts = [`${LISTEN_HOST}:${port}`, `localhost:${port}`]
  if (!allowedHosts.includes(request.headers.host ?? '')) {
    respondWithText({ response, statusCode: 403, text: 'Forbidden' })
    return
  }
  // `//%` のような URL は new URL が投げる。投げるとサーバーが落ちるので、先に断る
  const requestPath = request.url ?? '/'
  const baseUrl = `http://${LISTEN_HOST}`
  if (!URL.canParse(requestPath, baseUrl)) {
    respondWithText({ response, statusCode: 400, text: 'Bad Request' })
    return
  }
  const requestUrl = new URL(requestPath, baseUrl)
  if (requestUrl.pathname !== '/') {
    respondWithText({ response, statusCode: 404, text: 'Not Found' })
    return
  }
  const { view, selectedOutcome } = readPageQuery(requestUrl.searchParams)
  try {
    // TODO(#2034): 「いまの状況」の中身を作る
    const viewHtml = view === 'now' ? EMPTY_VIEW_HTML : renderRunsView(selectedOutcome)
    response
      .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      .end(renderPage({ view, viewHtml }))
  } catch (error) {
    // 記録ファイルが読めなかったとき。サーバーは止めず、次の読み直しでまた読みにいく
    respondWithText({ response, statusCode: 500, text: `実行記録を読めませんでした: ${error}` })
  }
}

/**
 * 文字だけの応答を返す。
 *
 * @param {{ response: import('node:http').ServerResponse, statusCode: number, text: string }} params 応答・状態コード・本文
 * @returns {void}
 */
function respondWithText({ response, statusCode, text }) {
  response.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' }).end(text)
}

/**
 * config.mjs から、待ち受けるポートを読む。
 *
 * @returns {number} ポート番号
 * @throws {TechnicalError} config.mjs の dashboard.port が無い、または整数でないとき
 */
function readDashboardPort() {
  const port = config.dashboard?.port
  if (port === undefined) {
    throw new TechnicalError(
      'config.mjs に dashboard.port がありません。scripts/auto-programmer/README.md の「設定値」を見て足してください'
    )
  }
  if (!Number.isInteger(port)) {
    throw new TechnicalError(
      `config.mjs の dashboard.port が整数ではありません（いまの値: ${JSON.stringify(port)}）`
    )
  }
  return port
}

/**
 * 画面のサーバーを起動する。待ち受けに失敗したら（ポートが使用中など）、理由を出して終了コード 1 で終わる。
 *
 * @returns {void}
 * @throws {TechnicalError} config.mjs の dashboard.port が無い、または整数でないとき
 */
function startDashboard() {
  const port = readDashboardPort()
  createServer((request, response) => respondToRequest({ request, response, port }))
    .on('error', (error) => {
      showError(`ダッシュボードを開けませんでした: ${formatErrorMessage(error)}`)
      process.exitCode = 1
    })
    .listen(port, LISTEN_HOST, () => {
      showInfo(`ダッシュボードを開きました: http://${LISTEN_HOST}:${port}/（止めるときは Ctrl+C）`)
      showInfo(`読んでいる記録: ${config.runLogPath}`)
    })
}

try {
  startDashboard()
} catch (error) {
  showError(formatErrorWithStack(error))
  process.exitCode = 1
}
