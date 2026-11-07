#!/usr/bin/env node
// 責務: `scripts/perf-report.mjs` の JSON を標準入力で受け、`/perf-report` のひな形（report-template.html）の
//   文字と数字を埋めて HTML を書き、その絶対パスを標準出力に返す。数える処理は `perf-report.mjs`、見た目と固定の文言はひな形が持つ。
//
// 設計意図（WHY）:
// - ひな形をスクリプトで埋める。文章の指示を読んだ AI に HTML を書かせると、合意した見た目からずれる（表や節が増える）。
//   同じ JSON から同じ HTML を出すためである（docs/policy/refined-engineer-judgment-principles.md「確率論より決定論」）。
// - HTML をこのスクリプトに持たせない。ひな形を HTML のまま開いて見た目を確かめ・直せるようにし、文言を直すたびにコードを直さずに済ませる。
//   `perf-report.mjs` にも足さない。あちらは取得と集計を担い、すでに大きい。
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
// TODO(#1642): 図を描く処理を足したら、図の場所を空文字で埋めるのをやめる（#1643・#1644 も同じ）
const FIGURE_PLACEHOLDER_NAMES = [
  'throughputFigure',
  'delegationFigure',
  'speedFigure',
  'reviewFigure',
  'sizeFigure'
]

// このスクリプトが JSON から読む項目のすべて
const REPORT_FIELD_SPECS = [
  { name: 'repository', jsonPath: 'repository', isValid: isNonEmptyText },
  { name: 'generatedOn', jsonPath: 'generatedOn', isValid: isDateText },
  { name: 'from', jsonPath: 'period.from', isValid: isDateText },
  { name: 'to', jsonPath: 'period.to', isValid: isDateText },
  { name: 'workIssueCount', jsonPath: 'workIssueCount', isValid: isCount },
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
  { name: 'under50Count', jsonPath: 'pullRequestDiffLines.bandCounts.under50', isValid: isCount },
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
 * ひな形の `{{名前}}` に入れる文字列を作る。値が無いものは null にする。
 *
 * @param {(fieldName: string) => any} readField readReportFields が返す、確かめ済みの項目を読む関数
 * @returns {Record<string, string | null>} 名前ごとの、HTML にそのまま入れてよい文字列
 */
function buildPlaceholderValues(readField) {
  const fullWeekSummary = readField('fullWeekSummary')
  const mergedPullRequestCount = readField('mergedPullRequestCount')
  const under50Count = readField('under50Count')
  const humanReviewTargetCount = readField('humanReviewTargetCount')
  return {
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
    ...Object.fromEntries(FIGURE_PLACEHOLDER_NAMES.map((placeholderName) => [placeholderName, '']))
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
