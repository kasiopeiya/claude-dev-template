#!/usr/bin/env node
// 責務: `scripts/perf-report.mjs` の JSON を標準入力で受け、`/perf-report` のひな形（report-template.html）の
//   文字と数字と図（svg）を埋めて HTML を書き、その絶対パスを標準出力に返す。数える処理は `perf-report.mjs`、図を除く見た目と固定の文言はひな形が持つ。
//
// 設計意図（WHY）:
// - ひな形をスクリプトで埋める。文章の指示を読んだ AI に HTML を書かせると、合意した見た目からずれる（表や節が増える）。
//   同じ JSON から同じ HTML を出すためである（docs/policy/refined-engineer-judgment-principles.md「確率論より決定論」）。
// - 図を除く HTML をこのスクリプトに持たせない。ひな形を HTML のまま開いて見た目を確かめ・直せるようにし、文言を直すたびにコードを直さずに済ませる。
//   `perf-report.mjs` にも足さない。あちらは取得と集計を担い、すでに大きい。
// - 図の svg はこのスクリプトが描く。ひな形に座標を書くと、棒の数が JSON で変わる図を表せないためである。縦棒の図は renderVerticalBarChart 1つで描き、基準線・棒・文字をそろえる。
// - 同じ JSON なら出力先まで同じにするため、ここでは今日の日付を取らない。ファイル名の日付は JSON の `generatedOn` を使う。
// - 値が無いときは null で表し、本文には `—` を出す（`NaN`・`null` を出さない）。0 は有効な値なので、無いこととは区別する。
// - ひな形の `<!-- if:名前 -->〜<!-- endif -->` は、その名前の値が null のときに消す。消える部分の中の `{{名前}}` は先に消えるので、値が要らない。
// - 割合は件数から四捨五入して整数にする。JSON の小数第1位の割合をさらに丸めると、二重に丸めて1ずれることがある。
// - 埋め終えてから書く。入力が読めない・ひな形に知らない `{{名前}}` が残る・マーカーが残るときは、何も書かずに止まる。
//   ひな形とこのスクリプトの対応がずれたときに、崩れた HTML を黙って出さないためである。
// - JSON は、使う項目すべてを型まで確かめてから読む。ファイル名に使う日付は形も確かめる（パスに混ざらないようにする）。
//   件数どうしの大小（部分が全体を超えないか）は確かめない。`perf-report.mjs` が作る JSON は、作り方からそろっている。
// - 確かめた項目は、表に書いた名前でしか読めない。名前が表とずれたまま `—` や `NaN` を黙って埋めるより、止まる方がよい。
//
// 使い方: npm run --silent perf-report -- [--from YYYY-MM-DD] [--to YYYY-MM-DD] | npm run --silent perf-report-html

import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { BusinessError, TechnicalError } from './lib/errors.mjs'

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TEMPLATE_PATH = path.join(
  REPOSITORY_ROOT,
  '.claude/skills/perf-report/assets/report-template.html'
)
const DESIGN_SYSTEM_PATH = path.join(REPOSITORY_ROOT, '.claude/skills/html/design-system')
const OUTPUT_DIRECTORY = path.join(REPOSITORY_ROOT, 'tmp/perf-report')

const MISSING_VALUE_TEXT = '—'
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const IF_BLOCK_PATTERN = /<!-- if:(\w+) -->([\s\S]*?)<!-- endif -->/g
const PLACEHOLDER_PATTERN = /\{\{(\w+)\}\}/g
const LEFTOVER_MARKER_PATTERN = /\{\{|<!-- (?:if:|endif)/
const FULL_WEEK_SUMMARY_KEYS = ['weekCount', 'average', 'min', 'max']
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000
// TODO(#1643): 図を描く処理を足したら、図の場所を空文字で埋めるのをやめる（#1644 も同じ）
const UNDRAWN_FIGURE_PLACEHOLDER_NAMES = ['delegationFigure', 'speedFigure', 'reviewFigure']

// 縦棒の図の形（Issue #1642 で決めた値）。座標は viewBox の中の値で、図の幅は svg の width="100%" で画面に合わせる
const CHART_BASE_WIDTH = 860
const CHART_MARGIN_X = 40
const CHART_BASELINE_Y = 280
const CHART_HEIGHT = 330
const CHART_MAX_BAR_HEIGHT = 230
const CHART_BAR_WIDTH = 36
const CHART_BAR_CORNER_RADIUS = 4
// 棒の下の「10/5〜」（14px）と「N日間」（12.5px）が、隣の棒の文字と重ならない最小の幅
const CHART_MIN_COLUMN_WIDTH = 64
// 色と線の太さは、デザインシステム（document.css）の変数で指す。値を写すと、デザインシステムを変えたときに図だけ古い値で残る
const CHART_BASELINE_COLOR = 'var(--mb-rule)'
const CHART_INK_COLOR = 'var(--mb-ink)'
const CHART_MUTED_COLOR = 'var(--mb-muted)'
const CHART_HOLLOW_FILL = 'var(--mb-surface)'
const CHART_HOLLOW_STROKE_WIDTH = 'var(--mb-border-w)'
const CHART_COUNT_GAP_ABOVE_BAR = 8
const CHART_LABEL_OFFSET_BELOW_BASELINE = 22
const CHART_NOTE_OFFSET_BELOW_BASELINE = 40
// 棒の上に件数と割合を2行で重ねるときの、件数の文字の下端を割合の文字の下端から離す距離
const CHART_PERCENT_LINE_HEIGHT = 17
// 図の上に大きな数字の専用の帯を取るときの、帯の高さ。棒が最大の高さでも、帯の文字と重ならない
const CHART_HEADLINE_BAND_HEIGHT = 80
const CHART_HEADLINE_LABEL_BASELINE_Y = 16
const CHART_HEADLINE_VALUE_BASELINE_Y = 56
const CHART_HEADLINE_COLUMN_WIDTH = 220
const CHART_COUNT_TEXT_STYLE = { fontSize: 16, fontWeight: 700, color: CHART_INK_COLOR }
const CHART_PERCENT_TEXT_STYLE = { fontSize: 13, fontWeight: 400, color: CHART_MUTED_COLOR }
const CHART_HEADLINE_LABEL_TEXT_STYLE = { fontSize: 14, fontWeight: 400, color: CHART_MUTED_COLOR }
const CHART_HEADLINE_VALUE_TEXT_STYLE = { fontSize: 34, fontWeight: 700, color: CHART_INK_COLOR }
const CHART_HEADLINE_UNIT_FONT_SIZE = 16
const CHART_LABEL_TEXT_STYLE = { fontSize: 14, fontWeight: 400, color: CHART_MUTED_COLOR }
const CHART_NOTE_TEXT_STYLE = { fontSize: 12.5, fontWeight: 400, color: CHART_MUTED_COLOR }

// 差分行数の帯。表示名と、件数を読む REPORT_FIELD_SPECS の name を組にして、並びと名前がずれないようにする
const DIFF_LINE_BANDS = [
  { bandLabel: '50行未満', countFieldName: 'under50Count' },
  { bandLabel: '50〜199行', countFieldName: 'from50To199Count' },
  { bandLabel: '200〜300行', countFieldName: 'from200To300Count' },
  { bandLabel: '300行超', countFieldName: 'over300Count' }
]

// このスクリプトが JSON から読む項目のすべて
const REPORT_FIELD_SPECS = [
  { name: 'repository', jsonPath: 'repository', isValid: isNonEmptyText },
  { name: 'generatedOn', jsonPath: 'generatedOn', isValid: isDateText },
  { name: 'from', jsonPath: 'period.from', isValid: isDateText },
  { name: 'to', jsonPath: 'period.to', isValid: isDateText },
  { name: 'workIssueCount', jsonPath: 'workIssueCount', isValid: isCount },
  { name: 'weeks', jsonPath: 'weeks', isValid: isWeekList },
  { name: 'aiOnlyCount', jsonPath: 'delegationCounts.aiOnly', isValid: isCount },
  { name: 'fullWeekSummary', jsonPath: 'fullWeekSummary', isValid: isFullWeekSummaryOrNull },
  {
    name: 'targetIssueCount',
    jsonPath: 'aiOnlyTimeToPullRequest.targetIssueCount',
    isValid: isCount
  },
  {
    name: 'measuredIssueCount',
    jsonPath: 'aiOnlyTimeToPullRequest.measuredIssueCount',
    isValid: isCount
  },
  {
    name: 'medianMinutes',
    jsonPath: 'aiOnlyTimeToPullRequest.medianMinutes',
    isValid: isNumberOrNull
  },
  {
    name: 'mergedPullRequestCount',
    jsonPath: 'pullRequestDiffLines.mergedPullRequestCount',
    isValid: isCount
  },
  { name: 'medianChangedLines', jsonPath: 'pullRequestDiffLines.median', isValid: isNumberOrNull },
  {
    name: 'averageChangedLines',
    jsonPath: 'pullRequestDiffLines.average',
    isValid: isNumberOrNull
  },
  { name: 'under50Count', jsonPath: 'pullRequestDiffLines.bandCounts.under50', isValid: isCount },
  {
    name: 'from50To199Count',
    jsonPath: 'pullRequestDiffLines.bandCounts.from50To199',
    isValid: isCount
  },
  {
    name: 'from200To300Count',
    jsonPath: 'pullRequestDiffLines.bandCounts.from200To300',
    isValid: isCount
  },
  { name: 'over300Count', jsonPath: 'pullRequestDiffLines.bandCounts.over300', isValid: isCount },
  { name: 'humanReviewTargetCount', jsonPath: 'humanReviewTargets.targetCount', isValid: isCount },
  { name: 'policyOrCicdCount', jsonPath: 'humanReviewTargets.policyOrCicdCount', isValid: isCount },
  { name: 'hasProductCode', jsonPath: 'hasProductCode', isValid: isBoolean }
]

/**
 * CLI として実行したときの本体。標準入力の JSON から HTML を書き、絶対パスを標準出力に返す。
 *
 * @returns {void}
 * @throws {BusinessError} 標準入力が perf-report の JSON として読めないとき（条件は parseReportJson・readReportFields）
 * @throws {TechnicalError} ひな形とこのスクリプトの対応がずれたとき（条件は fillTemplate）
 */
function runCli() {
  const readField = readReportFields(parseReportJson(readStandardInput()))
  const html = fillTemplate({
    template: readReportTemplate(),
    placeholderValues: buildPlaceholderValues(readField)
  })
  console.log(
    writeReport({
      generatedOn: readField('generatedOn'),
      from: readField('from'),
      to: readField('to'),
      html
    })
  )
}

/**
 * @returns {string} 標準入力の中身
 */
function readStandardInput() {
  return readFileSync(0, 'utf8')
}

/**
 * @returns {string} ひな形（report-template.html）の中身
 */
function readReportTemplate() {
  return readFileSync(TEMPLATE_PATH, 'utf8')
}

/**
 * @param {string} standardInput 標準入力の中身
 * @returns {unknown} JSON として読んだ結果。中身の形は確かめていない
 * @throws {BusinessError} 空のとき・JSON として読めないとき
 */
function parseReportJson(standardInput) {
  if (standardInput.trim() === '') {
    throw new BusinessError(
      '標準入力が空です。`npm run --silent perf-report | npm run --silent perf-report-html` のように、perf-report の JSON を渡してください'
    )
  }
  try {
    return JSON.parse(standardInput)
  } catch (error) {
    throw new BusinessError(`標準入力が JSON として読めません: ${error.message}`, { cause: error })
  }
}

/**
 * JSON から使う項目をすべて取り出し、型を確かめる。
 *
 * @param {unknown} report JSON として読んだ結果
 * @returns {(fieldName: string) => any} 確かめ済みの項目を、REPORT_FIELD_SPECS の name で読む関数。表に無い名前を渡すと TechnicalError で止まる
 * @throws {BusinessError} 項目が無いか、型・形が違うとき（該当する項目をすべて並べる）
 */
function readReportFields(report) {
  const fields = new Map()
  const invalidJsonPaths = []
  for (const { name, jsonPath, isValid } of REPORT_FIELD_SPECS) {
    const fieldValue = readJsonPath(report, jsonPath)
    fields.set(name, fieldValue)
    if (!isValid(fieldValue)) invalidJsonPaths.push(jsonPath)
  }
  if (invalidJsonPaths.length > 0) {
    throw new BusinessError(`JSON に、無いか型の違う値があります: ${invalidJsonPaths.join('・')}`)
  }
  return (fieldName) => {
    if (!fields.has(fieldName)) {
      throw new TechnicalError(`REPORT_FIELD_SPECS に無い項目を読みました: ${fieldName}`)
    }
    return fields.get(fieldName)
  }
}

/**
 * @param {unknown} source たどる元
 * @param {string} jsonPath `.` でつないだ項目名
 * @returns {unknown} たどった先の値。途中で切れていれば undefined
 */
function readJsonPath(source, jsonPath) {
  return jsonPath
    .split('.')
    .reduce((current, fieldName) => (current == null ? undefined : current[fieldName]), source)
}

/**
 * @param {unknown} candidate 調べる値
 * @returns {boolean} 空でない文字列なら true
 */
function isNonEmptyText(candidate) {
  return typeof candidate === 'string' && candidate !== ''
}

/**
 * @param {unknown} candidate 調べる値
 * @returns {boolean} YYYY-MM-DD の形の文字列なら true
 */
function isDateText(candidate) {
  return typeof candidate === 'string' && DATE_PATTERN.test(candidate)
}

/**
 * @param {unknown} candidate 調べる値
 * @returns {boolean} 0 以上の整数なら true
 */
function isCount(candidate) {
  return Number.isInteger(candidate) && candidate >= 0
}

/**
 * @param {unknown} candidate 調べる値
 * @returns {boolean} 有限の数か null なら true
 */
function isNumberOrNull(candidate) {
  return candidate === null || Number.isFinite(candidate)
}

/**
 * @param {unknown} candidate 調べる値
 * @returns {boolean} null か、週数・平均・最小・最大がすべて有限の数のオブジェクトなら true
 */
function isFullWeekSummaryOrNull(candidate) {
  if (candidate === null) return true
  return (
    typeof candidate === 'object' &&
    FULL_WEEK_SUMMARY_KEYS.every((summaryKey) => Number.isFinite(candidate[summaryKey]))
  )
}

/**
 * @param {unknown} candidate 調べる値
 * @returns {boolean} 真偽値なら true
 */
function isBoolean(candidate) {
  return typeof candidate === 'boolean'
}

/**
 * @param {unknown} candidate 調べる値
 * @returns {boolean} 1件以上あり、すべてが週の形（isWeek）の配列なら true
 */
function isWeekList(candidate) {
  return Array.isArray(candidate) && candidate.length > 0 && candidate.every(isWeek)
}

/**
 * @param {unknown} candidate 調べる値
 * @returns {boolean} 週の初日・最終日と、数えた範囲の初日・最終日（どれも YYYY-MM-DD）・件数（0 以上の整数）・全日そろったか（真偽値）が揃い、数えた範囲が日付として読めて1日以上なら true
 */
function isWeek(candidate) {
  if (candidate === null || typeof candidate !== 'object') return false
  const { weekStart, weekEnd, countedFrom, countedTo, workIssueCount, isFullWeek } = candidate
  return (
    [weekStart, weekEnd, countedFrom, countedTo].every(isDateText) &&
    isCount(workIssueCount) &&
    isBoolean(isFullWeek) &&
    countDaysInclusive({ fromDate: countedFrom, toDate: countedTo }) >= 1
  )
}

/**
 * ひな形の `{{名前}}` に入れる文字列を作る。値が無いものは null にする。
 *
 * @param {(fieldName: string) => any} readField readReportFields が返す、確かめ済みの項目を読む関数
 * @returns {Record<string, string | null>} 名前ごとの、HTML にそのまま入れてよい文字列
 */
function buildPlaceholderValues(readField) {
  const fullWeekSummary = readField('fullWeekSummary')
  const mergedPullRequestCount = readField('mergedPullRequestCount')
  const hasMergedPullRequest = mergedPullRequestCount > 0
  const under50Count = readField('under50Count')
  const humanReviewTargetCount = readField('humanReviewTargetCount')
  return {
    // まだ描かない図の場所を空にする。後ろの実際の値が上書きするよう、先頭に置く
    ...Object.fromEntries(
      UNDRAWN_FIGURE_PLACEHOLDER_NAMES.map((placeholderName) => [placeholderName, ''])
    ),
    repository: escapeHtml(readField('repository')),
    from: escapeHtml(readField('from')),
    to: escapeHtml(readField('to')),
    workIssueCount: formatNumber(readField('workIssueCount')),
    aiOnlyCount: formatNumber(readField('aiOnlyCount')),
    aiOnlyPercent: formatPercent({
      count: readField('aiOnlyCount'),
      totalCount: readField('workIssueCount')
    }),
    // 全日そろった週が無いとき、週数は 0 週である。平均と幅は出せない
    fullWeekCount: formatNumber(fullWeekSummary?.weekCount ?? 0),
    fullWeekAverage: formatNumber(fullWeekSummary?.average),
    fullWeekMin: formatNumber(fullWeekSummary?.min),
    fullWeekMax: formatNumber(fullWeekSummary?.max),
    targetIssueCount: formatNumber(readField('targetIssueCount')),
    measuredIssueCount: formatNumber(readField('measuredIssueCount')),
    medianMinutes: formatNumber(readField('medianMinutes')),
    mergedPullRequestCount: formatNumber(mergedPullRequestCount),
    humanReviewTargetCount: formatNumber(humanReviewTargetCount),
    humanReviewPercent: formatPercent({
      count: humanReviewTargetCount,
      totalCount: mergedPullRequestCount
    }),
    policyOrCicdCount: formatNumber(readField('policyOrCicdCount')),
    medianChangedLines: formatNumber(readField('medianChangedLines')),
    under50Count: formatNumber(under50Count),
    under50Percent: formatPercent({ count: under50Count, totalCount: mergedPullRequestCount }),
    // `if:noProductCode` の条件にだけ使う。app/・infra/ にコードが無いときだけ値を持つ
    noProductCode: readField('hasProductCode') ? null : 'true',
    // `if:noMergedPullRequest` の条件にだけ使う。マージした PR が0件のときだけ値を持つ
    noMergedPullRequest: hasMergedPullRequest ? null : 'true',
    throughputFigure: buildThroughputFigure(readField('weeks')),
    sizeFigure: hasMergedPullRequest ? buildSizeFigure(readField) : null
  }
}

/**
 * ひな形を埋める。先に `if` の囲みを解き、次に `{{名前}}` を置き換える。
 *
 * @param {{ template: string, placeholderValues: Record<string, string | null> }} fillSource ひな形と、名前ごとの値
 * @returns {string} 埋め終えた HTML
 * @throws {TechnicalError} ひな形に、値の定義が無い名前があるとき（値が null の名前は止めず `—` を出す）・埋め終えても `{{` や `if` のマーカーが残るとき
 */
function fillTemplate({ template, placeholderValues }) {
  const resolvedTemplate = template.replace(IF_BLOCK_PATTERN, (_block, placeholderName, body) =>
    lookUpValue(placeholderValues, placeholderName) === null ? '' : body
  )
  const html = resolvedTemplate.replace(PLACEHOLDER_PATTERN, (_placeholder, placeholderName) => {
    return lookUpValue(placeholderValues, placeholderName) ?? MISSING_VALUE_TEXT
  })
  if (LEFTOVER_MARKER_PATTERN.test(html)) {
    throw new TechnicalError('ひな形に、埋められない `{{` か `if` のマーカーが残りました')
  }
  return html
}

/**
 * @param {Record<string, string | null>} placeholderValues 名前ごとの値
 * @param {string} placeholderName ひな形に書かれた名前
 * @returns {string | null} 値。値が無ければ null
 * @throws {TechnicalError} この名前に対応する値の定義が無いとき。直すのはひな形かこのスクリプトを保守する人である
 */
function lookUpValue(placeholderValues, placeholderName) {
  if (!Object.hasOwn(placeholderValues, placeholderName)) {
    throw new TechnicalError(`ひな形に、値の定義が無い名前があります: ${placeholderName}`)
  }
  return placeholderValues[placeholderName]
}

/**
 * HTML を書く。同じ名前の HTML が既にあれば上書きする。デザインシステムは同じフォルダへコピーし、既にあるファイルは上書きしない。
 *
 * @param {{ generatedOn: string, from: string, to: string, html: string }} output YYYY-MM-DD の形を確かめた日付3つ（ファイル名に使う）と、書く HTML
 * @returns {string} 書いた HTML の絶対パス
 */
function writeReport({ generatedOn, from, to, html }) {
  const reportDate = generatedOn.replaceAll('-', '')
  const reportPath = path.join(OUTPUT_DIRECTORY, `${reportDate}-perf-report-${from}-${to}.html`)
  mkdirSync(OUTPUT_DIRECTORY, { recursive: true })
  cpSync(DESIGN_SYSTEM_PATH, path.join(OUTPUT_DIRECTORY, 'design-system'), {
    recursive: true,
    force: false
  })
  writeFileSync(reportPath, html)
  return reportPath
}

/**
 * 週ごとの作業 Issue 数を縦棒の図にする。全日そろっていない週は白抜きで、棒の下に数えた日数を添える。
 *
 * @param {{ weekStart: string, countedFrom: string, countedTo: string, workIssueCount: number, isFullWeek: boolean }[]} weeks 確かめ済みの週（1件以上）
 * @returns {string} svg 要素の HTML
 */
function buildThroughputFigure(weeks) {
  const bars = weeks.map(({ weekStart, countedFrom, countedTo, workIssueCount, isFullWeek }) => {
    const countedDays = countDaysInclusive({ fromDate: countedFrom, toDate: countedTo })
    const countedRange = `${countedFrom}〜${countedTo}`
    return {
      barAmount: workIssueCount,
      countText: String(workIssueCount),
      percentText: null,
      labelText: `${formatMonthDay(weekStart)}〜`,
      noteText: isFullWeek ? null : `${countedDays}日間`,
      hoverText: isFullWeek
        ? `${countedRange}：${workIssueCount}件`
        : `${countedRange}（${countedDays}日間・全日そろっていない週）：${workIssueCount}件`,
      isHollow: !isFullWeek
    }
  })
  return renderVerticalBarChart({ bars, chartTitle: '週ごとの作業 Issue 数' })
}

/**
 * マージした PR の差分行数を、4つの帯の縦棒と、中央値・平均の大きな数字にする。
 *
 * @param {(fieldName: string) => any} readField readReportFields が返す、確かめ済みの項目を読む関数
 * @returns {string} svg 要素の HTML。マージした PR が1件以上のときだけ呼ぶ（0件のときの文言は、ひな形の `if:noMergedPullRequest` が持つ）
 */
function buildSizeFigure(readField) {
  const mergedPullRequestCount = readField('mergedPullRequestCount')
  const medianChangedLines = readField('medianChangedLines')
  const averageChangedLines = readField('averageChangedLines')
  const bars = DIFF_LINE_BANDS.map(({ bandLabel, countFieldName }) => {
    const bandCount = readField(countFieldName)
    const percentText = `${formatPercent({ count: bandCount, totalCount: mergedPullRequestCount })}%`
    return {
      barAmount: bandCount,
      countText: String(bandCount),
      percentText,
      labelText: bandLabel,
      noteText: null,
      hoverText: `${bandLabel}：${bandCount}件（${percentText}）`,
      isHollow: false
    }
  })
  return renderVerticalBarChart({
    bars,
    chartTitle: '差分行数の帯ごとの PR 数',
    headlineNumbers: [
      {
        labelText: '中央値',
        valueText: formatNumber(medianChangedLines) ?? MISSING_VALUE_TEXT,
        unitText: '行'
      },
      {
        labelText: '平均',
        valueText: formatNumber(averageChangedLines) ?? MISSING_VALUE_TEXT,
        unitText: '行'
      }
    ]
  })
}

/**
 * 棒の高さを最大の棒に対する比で決める縦棒の図を描く。
 *
 * @param {{ bars: { barAmount: number, countText: string, percentText: string | null, labelText: string, noteText: string | null, hoverText: string, isHollow: boolean }[], chartTitle: string, headlineNumbers?: { labelText: string, valueText: string, unitText: string }[] }} chart 左から並べる棒（1本以上。barAmount は棒が表す量で、0 以上。percentText があれば件数の下に割合を重ねる）と、図の題（aria-label の頭に付く）と、図の上に大きな数字で並べる項目（省くと帯を取らない）
 * @returns {string} svg 要素の HTML。棒が増えても文字が重ならないよう、viewBox の幅を広げる。大きな数字を並べるときは、図の上に大きな数字の専用の帯（CHART_HEADLINE_BAND_HEIGHT）を足し、viewBox の高さもその分伸ばす
 */
function renderVerticalBarChart({ bars, chartTitle, headlineNumbers = [] }) {
  const columnWidth = Math.max(
    CHART_MIN_COLUMN_WIDTH,
    (CHART_BASE_WIDTH - 2 * CHART_MARGIN_X) / bars.length
  )
  const chartWidth = 2 * CHART_MARGIN_X + columnWidth * bars.length
  // 全部の棒が 0 のときも、0 で割らずに縮尺を決める
  const largestBarAmount = Math.max(1, ...bars.map(({ barAmount }) => barAmount))
  const barElements = bars.map((bar, barPosition) =>
    renderBar({
      bar,
      centerX: CHART_MARGIN_X + columnWidth * (barPosition + 0.5),
      barHeight: (bar.barAmount / largestBarAmount) * CHART_MAX_BAR_HEIGHT
    })
  )
  const hasHeadlineBand = headlineNumbers.length > 0
  const headlineBandHeight = hasHeadlineBand ? CHART_HEADLINE_BAND_HEIGHT : 0
  const ariaLabelParts = [
    ...headlineNumbers.map(
      ({ labelText, valueText, unitText }) => `${labelText}${valueText}${unitText}`
    ),
    ...bars.map(({ hoverText }) => hoverText)
  ]
  const ariaLabel = `${chartTitle}：${ariaLabelParts.join('／')}`
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 ${formatCoordinate(chartWidth)} ${CHART_HEIGHT + headlineBandHeight}" role="img" aria-label="${escapeHtml(ariaLabel)}">`,
    ...headlineNumbers.map((headlineNumber, numberPosition) =>
      renderHeadlineNumber({ headlineNumber, numberPosition })
    ),
    // 帯の無い図（週ごとの図）の svg を変えないよう、帯があるときだけ包んで下げる
    hasHeadlineBand ? `<g transform="translate(0 ${headlineBandHeight})">` : '',
    `<line x1="${CHART_MARGIN_X}" y1="${CHART_BASELINE_Y}" x2="${formatCoordinate(chartWidth - CHART_MARGIN_X)}" y2="${CHART_BASELINE_Y}" style="stroke:${CHART_BASELINE_COLOR}" />`,
    ...barElements,
    hasHeadlineBand ? '</g>' : '',
    '</svg>'
  ].join('')
}

/**
 * @param {{ headlineNumber: { labelText: string, valueText: string, unitText: string }, numberPosition: number }} headlineNumberPlacement 描く項目と、左から数えた位置
 * @returns {string} 見出しと太字の大きな数字を、左から numberPosition 番目の列に置いた g 要素の HTML。単位は数字より小さく添える
 */
function renderHeadlineNumber({ headlineNumber, numberPosition }) {
  const { labelText, valueText, unitText } = headlineNumber
  const leftX = formatCoordinate(CHART_MARGIN_X + CHART_HEADLINE_COLUMN_WIDTH * numberPosition)
  const labelStyle = CHART_HEADLINE_LABEL_TEXT_STYLE
  const valueStyle = CHART_HEADLINE_VALUE_TEXT_STYLE
  return [
    '<g>',
    `<text x="${leftX}" y="${CHART_HEADLINE_LABEL_BASELINE_Y}" font-size="${labelStyle.fontSize}" font-weight="${labelStyle.fontWeight}" style="fill:${labelStyle.color}">${escapeHtml(labelText)}</text>`,
    `<text x="${leftX}" y="${CHART_HEADLINE_VALUE_BASELINE_Y}" font-size="${valueStyle.fontSize}" font-weight="${valueStyle.fontWeight}" style="fill:${valueStyle.color}">${escapeHtml(valueText)}<tspan font-size="${CHART_HEADLINE_UNIT_FONT_SIZE}" font-weight="${labelStyle.fontWeight}" dx="2">${escapeHtml(unitText)}</tspan></text>`,
    '</g>'
  ].join('')
}

/**
 * @param {{ bar: { countText: string, percentText: string | null, labelText: string, noteText: string | null, hoverText: string, isHollow: boolean }, centerX: number, barHeight: number }} barPlacement 描く棒と、棒の中心の x、棒の高さ（0 以上）
 * @returns {string} 棒・件数（と割合）・棒の下の文字をまとめた g 要素の HTML。マウスを載せると hoverText が出る
 */
function renderBar({ bar, centerX, barHeight }) {
  const { labelText, noteText, hoverText, isHollow } = bar
  const noteElement =
    noteText === null
      ? ''
      : renderChartText({
          text: noteText,
          centerX,
          baselineY: CHART_BASELINE_Y + CHART_NOTE_OFFSET_BELOW_BASELINE,
          textStyle: CHART_NOTE_TEXT_STYLE
        })
  return [
    '<g>',
    `<title>${escapeHtml(hoverText)}</title>`,
    // 0 件の棒は高さが無く、角を丸める道筋も組めない。棒は描かず、件数（と割合）だけを基準線の上に出す
    barHeight > 0 ? renderBarShape({ centerX, barHeight, isHollow }) : '',
    renderBarAmountTexts({ bar, centerX, barTopY: CHART_BASELINE_Y - barHeight }),
    renderChartText({
      text: labelText,
      centerX,
      baselineY: CHART_BASELINE_Y + CHART_LABEL_OFFSET_BELOW_BASELINE,
      textStyle: CHART_LABEL_TEXT_STYLE
    }),
    noteElement,
    '</g>'
  ].join('')
}

/**
 * @param {{ bar: { countText: string, percentText: string | null }, centerX: number, barTopY: number }} amountPlacement 件数と割合の文字、棒の中心の x、棒の上端の y
 * @returns {string} 棒の上に置く件数の text 要素の HTML。割合があれば、件数の下に小さく添える
 */
function renderBarAmountTexts({ bar, centerX, barTopY }) {
  const { countText, percentText } = bar
  const lowestBaselineY = barTopY - CHART_COUNT_GAP_ABOVE_BAR
  if (percentText === null) {
    return renderChartText({
      text: countText,
      centerX,
      baselineY: lowestBaselineY,
      textStyle: CHART_COUNT_TEXT_STYLE
    })
  }
  return [
    renderChartText({
      text: countText,
      centerX,
      baselineY: lowestBaselineY - CHART_PERCENT_LINE_HEIGHT,
      textStyle: CHART_COUNT_TEXT_STYLE
    }),
    renderChartText({
      text: percentText,
      centerX,
      baselineY: lowestBaselineY,
      textStyle: CHART_PERCENT_TEXT_STYLE
    })
  ].join('')
}

/**
 * @param {{ centerX: number, barHeight: number, isHollow: boolean }} barShape 棒の中心の x、棒の高さ（0 より大きい）、白抜きにするか
 * @returns {string} 上の角が丸い棒の path 要素。白抜きなら黒の枠だけ、そうでなければ黒で塗る
 */
function renderBarShape({ centerX, barHeight, isHollow }) {
  const leftX = centerX - CHART_BAR_WIDTH / 2
  const rightX = leftX + CHART_BAR_WIDTH
  const topY = CHART_BASELINE_Y - barHeight
  // 丸みが棒の高さを超えると、角の曲線が基準線より下へ出る
  const cornerRadius = Math.min(CHART_BAR_CORNER_RADIUS, barHeight)
  const outline = [
    `M${formatCoordinate(leftX)} ${CHART_BASELINE_Y}`,
    `V${formatCoordinate(topY + cornerRadius)}`,
    `Q${formatCoordinate(leftX)} ${formatCoordinate(topY)} ${formatCoordinate(leftX + cornerRadius)} ${formatCoordinate(topY)}`,
    `H${formatCoordinate(rightX - cornerRadius)}`,
    `Q${formatCoordinate(rightX)} ${formatCoordinate(topY)} ${formatCoordinate(rightX)} ${formatCoordinate(topY + cornerRadius)}`,
    `V${CHART_BASELINE_Y}`,
    'Z'
  ].join(' ')
  const paint = isHollow
    ? `style="fill:${CHART_HOLLOW_FILL};stroke:${CHART_INK_COLOR};stroke-width:${CHART_HOLLOW_STROKE_WIDTH}"`
    : `style="fill:${CHART_INK_COLOR}"`
  return `<path d="${outline}" ${paint} />`
}

/**
 * @param {{ text: string, centerX: number, baselineY: number, textStyle: { fontSize: number, fontWeight: number, color: string } }} chartText 文字と、中央に置く x、文字の下端の y、見た目
 * @returns {string} text 要素の HTML
 */
function renderChartText({ text, centerX, baselineY, textStyle }) {
  const { fontSize, fontWeight, color } = textStyle
  return `<text x="${formatCoordinate(centerX)}" y="${formatCoordinate(baselineY)}" text-anchor="middle" font-size="${fontSize}" font-weight="${fontWeight}" style="fill:${color}">${escapeHtml(text)}</text>`
}

/**
 * @param {{ fromDate: string, toDate: string }} dateRange 初日と最終日（YYYY-MM-DD）
 * @returns {number} 両端を含む日数。月が1〜12の外などで日付として読めなければ NaN（2/30 のような日は翌月に繰り上げて数える）
 */
function countDaysInclusive({ fromDate, toDate }) {
  return (
    (Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) /
      MILLISECONDS_PER_DAY +
    1
  )
}

/**
 * @param {string} dateText YYYY-MM-DD の形の日付
 * @returns {string} 0 埋めしない月/日（2026-10-05 なら 10/5）
 */
function formatMonthDay(dateText) {
  return `${Number(dateText.slice(5, 7))}/${Number(dateText.slice(8, 10))}`
}

/**
 * @param {number} coordinate svg の座標
 * @returns {string} 小数第2位までに丸めた文字列（浮動小数の長い尾を出さない）
 */
function formatCoordinate(coordinate) {
  return String(Math.round(coordinate * 100) / 100)
}

/**
 * @param {unknown} rawNumber 数のはずの値
 * @returns {string | null} 有限の数ならそのままの文字列。それ以外（null・未定義）は null
 */
function formatNumber(rawNumber) {
  return Number.isFinite(rawNumber) ? String(rawNumber) : null
}

/**
 * @param {{ count: number, totalCount: number }} ratio 部分の件数と全体の件数
 * @returns {string | null} 四捨五入した整数の百分率。全体が 0 件なら null
 */
function formatPercent({ count, totalCount }) {
  // 先に 100 を掛ける。割ってから掛けると、ちょうど .5 になる値（23/40 など）が浮動小数の誤差で .4999… になり、1小さく丸まる
  return totalCount > 0 ? String(Math.round((count * 100) / totalCount)) : null
}

/**
 * @param {string} rawText エスケープ前の文字列
 * @returns {string} HTML に埋めてよい文字列
 */
function escapeHtml(rawText) {
  return rawText
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

try {
  runCli()
} catch (error) {
  console.error(error instanceof BusinessError ? error.message : error.stack)
  process.exit(1)
}
