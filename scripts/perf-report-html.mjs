#!/usr/bin/env node
// 責務: 保存した `scripts/perf-report.mjs` の集計結果（JSON）と、会話中の AI が書いた考察ファイル（JSON）を読み、
//   `/perf-report` のひな形（report-template.html）の文字と数字と図（svg）と考察を埋めて HTML を書き、その絶対パスを標準出力に返す。
//   数える処理は `perf-report.mjs`、考察の中身は AI、図と考察を除く見た目と固定の文言はひな形が持つ。
//
// 設計意図（WHY）:
// - ひな形をスクリプトで埋める。文章の指示を読んだ AI に HTML を書かせると、合意した見た目からずれる（表や節が増える）。
//   同じ集計結果と同じ考察ファイルから同じ HTML を出すためである（docs/policy/refined-engineer-judgment-principles.md「確率論より決定論」）。
//   打つたびに変わるのは考察の中身だけで、AI に書かせるのは文だけにする（#1684）。
// - 図を除く HTML をこのスクリプトに持たせない。ひな形を HTML のまま開いて見た目を確かめ・直せるようにし、文言を直すたびにコードを直さずに済ませる。
//   例外は考察で、1文を箇条書きの1行（`<li>`）にして埋める。文の数が考察ファイルで変わるためである。
//   `perf-report.mjs` にも足さない。あちらは取得と集計を担い、すでに大きい。
// - 考察ファイルは、集計結果のファイル名の末尾 `-aggregate.json` を `-discussion.json` に替えた名前で引く。
//   前に打った分の考察ファイルが、別の集計結果に使われないためである。
// - 考察ファイルが無い・崩れている・5指標のどれかが抜けている・「考察」の文が「と考えられる」で終わらないときは、何も書かずに止まり、原因をすべて並べる。
//   考察の無いレポートや、推測を事実のように書いたレポートを配らないためである。文末は機械で判定できるので、文章の指示に任せない。
//   値が無い指標（期間内に作業 Issue・測れた Issue・マージした PR が無い）だけは、決まった1文（NO_VALUE_DISCUSSION_SENTENCE）を文末の検査から外す。
//   「値が無い」は事実で、「と考えられる」で終えると推測に見えるためである。言い換えを許すと文末の検査が骨抜きになるので、1文に固定する。
// - 図の svg はこのスクリプトが描く。ひな形に座標を書くと、棒の数が JSON で変わる図を表せないためである。縦棒の図（積み上げの棒も）は renderVerticalBarChart、横棒の図は renderHorizontalBarChart で描き、それぞれ基準線・棒・文字をそろえる。
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
// 使い方: npm run --silent perf-report-html -- tmp/perf-report/<日時>-perf-report-aggregate.json
//   考察ファイル（同じフォルダの <日時>-perf-report-discussion.json）を先に書いておく。手順は `.claude/skills/perf-report/SKILL.md`

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
const AGGREGATE_FILE_SUFFIX = '-aggregate.json'
const DISCUSSION_FILE_SUFFIX = '-discussion.json'
const DISCUSSION_SENTENCE_ENDING_PATTERN = /と考えられる。?$/
const NO_VALUE_DISCUSSION_SENTENCE = '期間内に値が無いので考察しない'
const DISCUSSION_ENTRY_KEYS = ['resultSentences', 'discussionSentences']
// TODO(#1643): 図を描く処理を足したら、図の場所を空文字で埋めるのをやめる
const UNDRAWN_FIGURE_PLACEHOLDER_NAMES = []

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
const CHART_MAIN_TEXT_GAP_ABOVE_BAR = 8
const CHART_LABEL_OFFSET_BELOW_BASELINE = 22
const CHART_NOTE_OFFSET_BELOW_BASELINE = 40
// 棒の上に mainText と subText を2行で重ねるときの、mainText の文字の下端を subText の文字の下端から離す距離
const CHART_SUB_TEXT_LINE_HEIGHT = 17
// 図の上に大きな数字の専用の帯を取るときの、帯の高さ。棒が最大の高さでも、帯の文字と重ならない
const CHART_HEADLINE_BAND_HEIGHT = 80
const CHART_HEADLINE_LABEL_BASELINE_Y = 16
const CHART_HEADLINE_VALUE_BASELINE_Y = 56
const CHART_HEADLINE_COLUMN_WIDTH = 220
// 図の主な文字（縦棒は棒の上の mainText、横棒は棒の右の件数）
const CHART_MAIN_TEXT_STYLE = { fontSize: 16, fontWeight: 700, color: CHART_INK_COLOR }
const CHART_SUB_TEXT_STYLE = { fontSize: 13, fontWeight: 400, color: CHART_MUTED_COLOR }
const CHART_HEADLINE_LABEL_TEXT_STYLE = { fontSize: 14, fontWeight: 400, color: CHART_MUTED_COLOR }
const CHART_HEADLINE_VALUE_TEXT_STYLE = { fontSize: 34, fontWeight: 700, color: CHART_INK_COLOR }
const CHART_HEADLINE_UNIT_FONT_SIZE = 16
// 凡例の専用の帯（Issue #1662 で決めた値）。帯の中の座標は、帯の上端からの距離で指す
const CHART_LEGEND_BAND_HEIGHT = 40
const CHART_LEGEND_SWATCH_TOP_OFFSET = 14
const CHART_LEGEND_SWATCH_SIZE = 12
const CHART_LEGEND_SWATCH_CORNER_RADIUS = 2
const CHART_LEGEND_TEXT_GAP_AFTER_SWATCH = 6
// 「人間レビューの対象」(13px・9字) の幅に収まり、次の凡例と重ならない幅
const CHART_LEGEND_COLUMN_WIDTH = 180
const CHART_LEGEND_TEXT_STYLE = { fontSize: 13, fontWeight: 400, color: CHART_INK_COLOR }
// 積み上げの棒の段と段の間の隙間。段が低いときは、段の高さの半分までに縮める
const CHART_STACK_SEGMENT_GAP = 2
const CHART_LABEL_TEXT_STYLE = { fontSize: 14, fontWeight: 400, color: CHART_MUTED_COLOR }
const CHART_NOTE_TEXT_STYLE = { fontSize: 12.5, fontWeight: 400, color: CHART_MUTED_COLOR }

// 棒の後ろに敷く薄い灰色の面（backdrop）と、面の上部の注記（8時間以上の帯）。デザインシステムに、この灰色の変数が無い（document.css の `p code` などの背景が同じ値の直書き）ので、ここで名前を付ける。`--mb-surface`（白）とは別の色である
const CHART_BACKDROP_FILL = '#F1EFE9'
const CHART_BACKDROP_CORNER_RADIUS = 8
const CHART_BACKDROP_PADDING_X = 8
const CHART_BACKDROP_EDGE_INSET = 4
const CHART_BACKDROP_EXTENT_BELOW_BASELINE = 32
const CHART_BACKDROP_NOTE_FIRST_BASELINE_Y = 16
const CHART_BACKDROP_NOTE_LINE_HEIGHT = 18
const CHART_BACKDROP_NOTE_BOTTOM_PADDING = 6

// 横棒の図の形（Issue #1658 で決めた値）。viewBox の幅は縦棒と同じ CHART_BASE_WIDTH で、色と線は縦棒と同じ変数で指す
const HORIZONTAL_CHART_BAR_THICKNESS = 24
const HORIZONTAL_CHART_ROW_SPACING = 58
const HORIZONTAL_CHART_BAR_START_X = 340
const HORIZONTAL_CHART_MAX_BAR_LENGTH = 350
const HORIZONTAL_CHART_PADDING_Y = 20
const HORIZONTAL_CHART_TEXT_GAP_AFTER_BAR = 8
// 左の文字は、棒の始まりの手前で右にそろえる。左にそろえると、長い分類の説明が棒の始まりや「0件」に届く
const HORIZONTAL_CHART_TEXT_RIGHT_X = HORIZONTAL_CHART_BAR_START_X - 20
// 分類名と分類の説明を行の中心に対して上下に振り分ける
const HORIZONTAL_CHART_CATEGORY_NAME_OFFSET_FROM_ROW_CENTER = -2
const HORIZONTAL_CHART_CATEGORY_DESCRIPTION_OFFSET_FROM_ROW_CENTER = 14
const HORIZONTAL_CHART_COUNT_OFFSET_FROM_ROW_CENTER = 6
const HORIZONTAL_CHART_BASELINE_OVERHANG = 8
const CHART_CATEGORY_NAME_TEXT_STYLE = { fontSize: 15, fontWeight: 700, color: CHART_INK_COLOR }
const CHART_CATEGORY_DESCRIPTION_TEXT_STYLE = {
  fontSize: 12.5,
  fontWeight: 400,
  color: CHART_MUTED_COLOR
}
// 件数のすぐ後ろに続ける割合や添え書き
const CHART_COUNT_TRAILING_TEXT_STYLE = { fontSize: 13, fontWeight: 400, color: CHART_MUTED_COLOR }
const CHART_COUNT_TRAILING_TEXT_GAP = 8

// 委譲の度合いの図の行。上から並べる順で、delegationCategory は JSON の delegationCounts のキー。categoryDescription は、その分類がどんな Issue かの説明
const DELEGATION_ROWS = [
  {
    delegationCategory: 'aiOnly',
    categoryName: 'AI 単独',
    categoryDescription: 'AI が人間の判断を待たずに作業'
  },
  {
    delegationCategory: 'collaboration',
    categoryName: '共同',
    categoryDescription: '人間と AI が対話して作る',
    zeroCountNoteText: '対話で作った成果物がこの期間に無い'
  },
  {
    delegationCategory: 'humanOnly',
    categoryName: '人間単独',
    categoryDescription: '残りの作業を人間が行う'
  },
  {
    delegationCategory: 'unclassified',
    categoryName: '分類なし',
    categoryDescription: '上のどれにも当たらない'
  }
]

// 人間レビューの図の凡例。積み上げの棒の段も、ここの fillColor を指す（見本と段の色がずれないようにする）。
// 対象外の灰色は、デザインシステム（document.css）の変数に、この段に合う灰色が無いため、Issue #1662 で決めた値を直に書く
const REVIEW_TARGET_LEGEND_ITEM = { labelText: '人間レビューの対象', fillColor: CHART_INK_COLOR }
const REVIEW_NON_TARGET_LEGEND_ITEM = { labelText: '対象外', fillColor: '#B0B0B0' }

// 差分行数の帯。表示名と、件数を読む REPORT_FIELD_SPECS の name を組にして、並びと名前がずれないようにする
const DIFF_LINE_BANDS = [
  { bandLabel: '50行未満', countFieldName: 'under50Count' },
  { bandLabel: '50〜199行', countFieldName: 'from50To199Count' },
  { bandLabel: '200〜300行', countFieldName: 'from200To300Count' },
  { bandLabel: '300行超', countFieldName: 'over300Count' }
]

// 着手から PR が出るまでの時間の帯。左から並べる順で、bandKey は JSON の aiOnlyTimeToPullRequest.bandCounts のキー。isStopped の帯は作業時間ではなく停止として、面（backdrop）の上に白抜きで描く
const TIME_TO_PULL_REQUEST_BANDS = [
  { bandKey: 'under5Minutes', labelText: '5分未満' },
  { bandKey: 'from5To14Minutes', labelText: '5〜14分' },
  { bandKey: 'from15To59Minutes', labelText: '15〜59分' },
  { bandKey: 'from1To8Hours', labelText: '1〜8時間' },
  { bandKey: 'atLeast8Hours', labelText: '8時間以上', isStopped: true }
]
const STOPPED_BAND_NOTE_LINES = ['作業ではなく停止', 'エラーや判断待ちで止まっていた時間']

// このスクリプトが JSON から読む項目のすべて
const REPORT_FIELD_SPECS = [
  { name: 'repository', jsonPath: 'repository', isValid: isNonEmptyText },
  { name: 'generatedOn', jsonPath: 'generatedOn', isValid: isDateText },
  { name: 'from', jsonPath: 'period.from', isValid: isDateText },
  { name: 'to', jsonPath: 'period.to', isValid: isDateText },
  { name: 'workIssueCount', jsonPath: 'workIssueCount', isValid: isCount },
  { name: 'weeks', jsonPath: 'weeks', isValid: isWeekList },
  { name: 'aiOnlyCount', jsonPath: 'delegationCounts.aiOnly', isValid: isCount },
  { name: 'collaborationCount', jsonPath: 'delegationCounts.collaboration', isValid: isCount },
  { name: 'humanOnlyCount', jsonPath: 'delegationCounts.humanOnly', isValid: isCount },
  { name: 'unclassifiedCount', jsonPath: 'delegationCounts.unclassified', isValid: isCount },
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
    name: 'underOneHourCount',
    jsonPath: 'aiOnlyTimeToPullRequest.underOneHourCount',
    isValid: isCount
  },
  ...TIME_TO_PULL_REQUEST_BANDS.map(({ bandKey }) => ({
    name: `${bandKey}Count`,
    jsonPath: `aiOnlyTimeToPullRequest.bandCounts.${bandKey}`,
    isValid: isCount
  })),
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

// 考察を書く5指標。上から、ひな形に並ぶ順。metricKey は考察ファイルのキーで、ひな形の `{{<metricKey>ResultItems}}`・`{{<metricKey>DiscussionItems}}` の頭にも使う。
// hasNoValue は、その指標の値が期間内に無いかを返す。値が無い指標だけ、NO_VALUE_DISCUSSION_SENTENCE を文末の検査から外す
const DISCUSSION_METRICS = [
  { metricKey: 'throughput', metricName: 'Issue処理スループット', hasNoValue: () => false },
  {
    metricKey: 'delegation',
    metricName: 'AIへの委譲度',
    hasNoValue: (readField) => readField('workIssueCount') === 0
  },
  {
    metricKey: 'speed',
    metricName: 'Issue１つあたりのリードタイム分布',
    hasNoValue: (readField) => readField('measuredIssueCount') === 0
  },
  {
    metricKey: 'review',
    metricName: '人間レビュー対象の割合',
    hasNoValue: (readField) => readField('mergedPullRequestCount') === 0
  },
  {
    metricKey: 'size',
    metricName: '変更の小ささ',
    hasNoValue: (readField) => readField('mergedPullRequestCount') === 0
  }
]

/**
 * CLI として実行したときの本体。引数の集計結果と、名前から引いた考察ファイルから HTML を書き、絶対パスを標準出力に返す。
 *
 * @returns {void}
 * @throws {BusinessError} 引数が違うとき・集計結果か考察ファイルが読めないとき・考察ファイルが決まりに合わないとき（条件は readAggregatePathArgument・readJsonFile・readReportFields・readDiscussions）
 * @throws {TechnicalError} ひな形とこのスクリプトの対応がずれたとき（条件は fillTemplate）
 */
function runCli() {
  const aggregatePath = readAggregatePathArgument(process.argv.slice(2))
  const readField = readReportFields(
    readJsonFile({ filePath: aggregatePath, fileLabel: '集計結果' })
  )
  const discussions = readDiscussions({
    discussionContent: readJsonFile({
      filePath: deriveDiscussionPath(aggregatePath),
      fileLabel: '考察ファイル'
    }),
    readField
  })
  const html = fillTemplate({
    template: readReportTemplate(),
    placeholderValues: {
      ...buildPlaceholderValues(readField),
      ...buildDiscussionPlaceholderValues(discussions)
    }
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
 * @param {string[]} cliArguments コマンドに渡された引数
 * @returns {string} 集計結果の絶対パス
 * @throws {BusinessError} 引数が1つでないとき・ファイル名が `-aggregate.json` で終わらないとき
 */
function readAggregatePathArgument(cliArguments) {
  const usageText =
    '`npm run --silent perf-report -- [--from YYYY-MM-DD] [--to YYYY-MM-DD] > tmp/perf-report/<日時>-perf-report-aggregate.json` で集計結果を保存し、同じフォルダに <日時>-perf-report-discussion.json の考察ファイルを書いてから、`npm run --silent perf-report-html -- tmp/perf-report/<日時>-perf-report-aggregate.json` を打ってください（手順は .claude/skills/perf-report/SKILL.md）'
  if (cliArguments.length !== 1) {
    throw new BusinessError(`集計結果のパスを1つ渡してください。${usageText}`)
  }
  const [aggregatePath] = cliArguments
  if (!aggregatePath.endsWith(AGGREGATE_FILE_SUFFIX)) {
    throw new BusinessError(
      `集計結果のファイル名は ${AGGREGATE_FILE_SUFFIX} で終えてください（考察ファイルの名前をここから決めるため）: ${aggregatePath}`
    )
  }
  return path.resolve(aggregatePath)
}

/**
 * @param {string} aggregatePath `-aggregate.json` で終わる集計結果の絶対パス
 * @returns {string} 同じフォルダの、末尾を `-discussion.json` に替えた考察ファイルの絶対パス
 */
function deriveDiscussionPath(aggregatePath) {
  return `${aggregatePath.slice(0, -AGGREGATE_FILE_SUFFIX.length)}${DISCUSSION_FILE_SUFFIX}`
}

/**
 * @returns {string} ひな形（report-template.html）の中身
 */
function readReportTemplate() {
  return readFileSync(TEMPLATE_PATH, 'utf8')
}

/**
 * @param {{ filePath: string, fileLabel: string }} jsonFile 読むファイルの絶対パスと、エラーに出す呼び名
 * @returns {unknown} JSON として読んだ結果。中身の形は確かめていない
 * @throws {BusinessError} ファイルが無いとき・空のとき・JSON として読めないとき
 */
function readJsonFile({ filePath, fileLabel }) {
  const jsonText = readExistingFile({ filePath, fileLabel })
  if (jsonText.trim() === '') {
    throw new BusinessError(`${fileLabel}が空です: ${filePath}`)
  }
  try {
    return JSON.parse(jsonText)
  } catch (error) {
    throw new BusinessError(
      `${fileLabel}が JSON として読めません（${filePath}）: ${error.message}`,
      {
        cause: error
      }
    )
  }
}

/**
 * @param {{ filePath: string, fileLabel: string }} targetFile 読むファイルの絶対パスと、エラーに出す呼び名
 * @returns {string} ファイルの中身
 * @throws {BusinessError} ファイルが無いとき
 */
function readExistingFile({ filePath, fileLabel }) {
  try {
    return readFileSync(filePath, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    throw new BusinessError(`${fileLabel}がありません: ${filePath}`, { cause: error })
  }
}

/**
 * 考察ファイルを確かめ、5指標ごとの「結果」と「考察」の文を取り出す。
 *
 * @param {{ discussionContent: unknown, readField: (fieldName: string) => any }} discussionSource JSON として読んだ考察ファイルと、readReportFields が返す、確かめ済みの項目を読む関数（値が無い指標を見分けるのに使う）
 * @returns {Record<string, { resultSentences: string[], discussionSentences: string[] }>} metricKey ごとの文。「結果」が無い指標は空の配列
 * @throws {BusinessError} 考察ファイルが決まりに合わないとき（合わない箇所をすべて並べる。条件は collectDiscussionProblems）
 */
function readDiscussions({ discussionContent, readField }) {
  const discussionProblems = collectDiscussionProblems({ discussionContent, readField })
  if (discussionProblems.length > 0) {
    throw new BusinessError(
      `考察ファイルが決まりに合いません。直して HTML を作る段だけを打ち直してください:\n- ${discussionProblems.join('\n- ')}`
    )
  }
  return Object.fromEntries(
    DISCUSSION_METRICS.map(({ metricKey }) => {
      const { resultSentences = [], discussionSentences } = discussionContent[metricKey]
      return [metricKey, { resultSentences, discussionSentences }]
    })
  )
}

/**
 * @param {{ discussionContent: unknown, readField: (fieldName: string) => any }} discussionSource readDiscussions と同じ
 * @returns {string[]} 決まりに合わない箇所の説明。オブジェクトでない・知らないキーがある・5指標のどれかが抜けている・指標ごとの形が違う（collectMetricDiscussionProblems）
 */
function collectDiscussionProblems({ discussionContent, readField }) {
  if (!isPlainObject(discussionContent)) {
    return ['考察ファイルの中身が、指標ごとのキーを持つオブジェクトではありません']
  }
  const metricKeys = DISCUSSION_METRICS.map(({ metricKey }) => metricKey)
  const unknownKeys = Object.keys(discussionContent).filter(
    (topLevelKey) => !metricKeys.includes(topLevelKey)
  )
  const missingMetrics = DISCUSSION_METRICS.filter(
    ({ metricKey }) => !Object.hasOwn(discussionContent, metricKey)
  )
  return [
    ...(unknownKeys.length > 0 ? [`知らないキーがあります: ${unknownKeys.join('・')}`] : []),
    ...(missingMetrics.length > 0
      ? [`指標が抜けています: ${missingMetrics.map(describeMetric).join('・')}`]
      : []),
    ...DISCUSSION_METRICS.filter(({ metricKey }) =>
      Object.hasOwn(discussionContent, metricKey)
    ).flatMap((metric) =>
      collectMetricDiscussionProblems({
        metric,
        metricDiscussion: discussionContent[metric.metricKey],
        hasNoValue: metric.hasNoValue(readField)
      })
    )
  ]
}

/**
 * @param {{ metric: { metricKey: string, metricName: string }, metricDiscussion: unknown, hasNoValue: boolean }} metricSource 指標と、考察ファイルのその指標の中身と、その指標の値が期間内に無いか
 * @returns {string[]} 決まりに合わない箇所の説明。オブジェクトでない・知らないキーがある・「結果」が文の配列でない・「考察」が1文以上の文の配列でない・「考察」の文が「と考えられる」で終わらない（値が無い指標の NO_VALUE_DISCUSSION_SENTENCE は除く）
 */
function collectMetricDiscussionProblems({ metric, metricDiscussion, hasNoValue }) {
  const metricLabel = describeMetric(metric)
  if (!isPlainObject(metricDiscussion)) {
    return [
      `${metricLabel}: resultSentences と discussionSentences を持つオブジェクトではありません`
    ]
  }
  const { resultSentences, discussionSentences } = metricDiscussion
  const unknownKeys = Object.keys(metricDiscussion).filter(
    (entryKey) => !DISCUSSION_ENTRY_KEYS.includes(entryKey)
  )
  const shapeProblems = [
    ...(unknownKeys.length > 0
      ? [`${metricLabel}: 知らないキーがあります: ${unknownKeys.join('・')}`]
      : []),
    ...(resultSentences === undefined || isSentenceList(resultSentences)
      ? []
      : [`${metricLabel}: resultSentences が、空でない文字列の配列ではありません`]),
    ...(isSentenceList(discussionSentences) && discussionSentences.length > 0
      ? []
      : [`${metricLabel}: discussionSentences が、1文以上の空でない文字列の配列ではありません`])
  ]
  if (shapeProblems.length > 0) return shapeProblems
  return discussionSentences
    .filter((sentence) => !isAllowedDiscussionSentence({ sentence, hasNoValue }))
    .map(
      (sentence) =>
        `${metricLabel}: 「考察」の文が「と考えられる」で終わっていません: 「${sentence}」`
    )
}

/**
 * @param {{ sentence: string, hasNoValue: boolean }} sentenceSource 「考察」の文1つと、その指標の値が期間内に無いか
 * @returns {boolean} 「と考えられる」（句点は任意）で終わるか、値が無い指標の NO_VALUE_DISCUSSION_SENTENCE（句点は任意）なら true
 */
function isAllowedDiscussionSentence({ sentence, hasNoValue }) {
  const trimmedSentence = sentence.trim()
  if (DISCUSSION_SENTENCE_ENDING_PATTERN.test(trimmedSentence)) return true
  return hasNoValue && trimmedSentence.replace(/。$/, '') === NO_VALUE_DISCUSSION_SENTENCE
}

/**
 * @param {{ metricKey: string, metricName: string }} metric 考察を書く指標
 * @returns {string} エラーに出す「throughput（Issue処理スループット）」の形の呼び名。直す人が考察ファイルのキーを探せるよう、キーを先に出す
 */
function describeMetric({ metricKey, metricName }) {
  return `${metricKey}（${metricName}）`
}

/**
 * @param {unknown} candidate 調べる値
 * @returns {boolean} null でも配列でもないオブジェクトなら true
 */
function isPlainObject(candidate) {
  return candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)
}

/**
 * @param {unknown} candidate 調べる値
 * @returns {boolean} すべてが空白だけでない文字列の配列なら true（空の配列も true）
 */
function isSentenceList(candidate) {
  return (
    Array.isArray(candidate) &&
    candidate.every((sentence) => typeof sentence === 'string' && sentence.trim() !== '')
  )
}

/**
 * ひな形の `{{<metricKey>ResultItems}}`・`{{<metricKey>DiscussionItems}}` に入れる箇条書きを作る。「結果」が無い指標は null にして、ひな形の `if` の囲み（「結果」の見出しごと）を消す。
 *
 * @param {Record<string, { resultSentences: string[], discussionSentences: string[] }>} discussions readDiscussions が返す、metricKey ごとの文
 * @returns {Record<string, string | null>} 名前ごとの、HTML にそのまま入れてよい `<li>` の並び
 */
function buildDiscussionPlaceholderValues(discussions) {
  return Object.fromEntries(
    DISCUSSION_METRICS.flatMap(({ metricKey }) => {
      const { resultSentences, discussionSentences } = discussions[metricKey]
      return [
        [
          `${metricKey}ResultItems`,
          resultSentences.length > 0 ? renderSentenceItems(resultSentences) : null
        ],
        [`${metricKey}DiscussionItems`, renderSentenceItems(discussionSentences)]
      ]
    })
  )
}

/**
 * @param {string[]} sentences 1文以上の文
 * @returns {string} 1文を1つの `<li>` にして改行でつないだ HTML。`{` `}` も文字参照にする。AI の文に `{{` があると、埋め終えた後のマーカーの検査がひな形の誤りと取り違えて止まるためである
 */
function renderSentenceItems(sentences) {
  return sentences
    .map(
      (sentence) =>
        `<li>${escapeHtml(sentence.trim()).replaceAll('{', '&#123;').replaceAll('}', '&#125;')}</li>`
    )
    .join('\n')
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
    throw new BusinessError(
      `集計結果の JSON に、無いか型の違う値があります:${invalidJsonPaths.join('・')}`
    )
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
 * @returns {boolean} 週の初日・最終日と、数えた範囲の初日・最終日（どれも YYYY-MM-DD）・件数（0 以上の整数）・全日そろったか（真偽値）・週ごとの人間レビューの対象（isWeeklyHumanReviewTargets）が揃い、数えた範囲が日付として読めて1日以上なら true
 */
function isWeek(candidate) {
  if (candidate === null || typeof candidate !== 'object') return false
  const {
    weekStart,
    weekEnd,
    countedFrom,
    countedTo,
    workIssueCount,
    isFullWeek,
    humanReviewTargets
  } = candidate
  return (
    [weekStart, weekEnd, countedFrom, countedTo].every(isDateText) &&
    isCount(workIssueCount) &&
    isBoolean(isFullWeek) &&
    isWeeklyHumanReviewTargets(humanReviewTargets) &&
    countDaysInclusive({ fromDate: countedFrom, toDate: countedTo }) >= 1
  )
}

/**
 * @param {unknown} candidate 調べる値
 * @returns {boolean} マージした PR の件数・対象の件数（どちらも 0 以上の整数）・対象の割合（有限の数。その週にマージした PR が無ければ null）が揃ったオブジェクトなら true
 */
function isWeeklyHumanReviewTargets(candidate) {
  if (candidate === null || typeof candidate !== 'object') return false
  const { mergedPullRequestCount, targetCount, targetPercentage } = candidate
  return isCount(mergedPullRequestCount) && isCount(targetCount) && isNumberOrNull(targetPercentage)
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
  const workIssueCount = readField('workIssueCount')
  return {
    // まだ描かない図の場所を空にする。後ろの実際の値が上書きするよう、先頭に置く
    ...Object.fromEntries(
      UNDRAWN_FIGURE_PLACEHOLDER_NAMES.map((placeholderName) => [placeholderName, ''])
    ),
    repositoryName: escapeHtml(readField('repository').split('/').pop()),
    from: escapeHtml(readField('from')),
    to: escapeHtml(readField('to')),
    workIssueCount: formatNumber(workIssueCount),
    aiOnlyCount: formatNumber(readField('aiOnlyCount')),
    aiOnlyPercent: formatPercent({
      count: readField('aiOnlyCount'),
      totalCount: workIssueCount
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
    sizeFigure: hasMergedPullRequest ? buildSizeFigure(readField) : null,
    reviewFigure: hasMergedPullRequest ? buildReviewFigure(readField('weeks')) : null,
    ...buildDelegationPlaceholderValues(readField),
    ...buildSpeedPlaceholderValues(readField)
  }
}

/**
 * 委譲の度合いの図の場所に入れる値を作る。作業 Issue が無い期間は図を null にして、ひな形の `if:delegationFigure` の囲み（図と説明）を消し、`if:noWorkIssue` の文に差し替える。
 *
 * @param {(fieldName: string) => any} readField readReportFields が返す、確かめ済みの項目を読む関数
 * @returns {{ delegationFigure: string | null, noWorkIssue: string | null }} 図の svg（作業 Issue が無ければ null）と、`if:noWorkIssue` の条件（作業 Issue が無いときだけ値を持つ）
 */
function buildDelegationPlaceholderValues(readField) {
  const workIssueCount = readField('workIssueCount')
  if (workIssueCount === 0) return { delegationFigure: null, noWorkIssue: 'true' }
  return {
    delegationFigure: buildDelegationFigure({
      workIssueCount,
      delegationCounts: {
        aiOnly: readField('aiOnlyCount'),
        collaboration: readField('collaborationCount'),
        humanOnly: readField('humanOnlyCount'),
        unclassified: readField('unclassifiedCount')
      }
    }),
    noWorkIssue: null
  }
}

/**
 * 着手から PR が出るまでの時間の図の場所に入れる値を作る。測れた Issue が無い期間は図を null にして、ひな形の `if:speedFigure` の囲み（図と説明）を消し、`if:noMeasuredIssue` の文に差し替える。
 *
 * @param {(fieldName: string) => any} readField readReportFields が返す、確かめ済みの項目を読む関数
 * @returns {{ speedFigure: string | null, noMeasuredIssue: string | null }} 図の svg（測れた Issue が無ければ null）と、`if:noMeasuredIssue` の条件（測れた Issue が無いときだけ値を持つ）
 */
function buildSpeedPlaceholderValues(readField) {
  const measuredIssueCount = readField('measuredIssueCount')
  if (measuredIssueCount === 0) return { speedFigure: null, noMeasuredIssue: 'true' }
  return {
    speedFigure: buildSpeedFigure({
      measuredIssueCount,
      medianMinutes: readField('medianMinutes'),
      underOneHourCount: readField('underOneHourCount'),
      bandCounts: Object.fromEntries(
        TIME_TO_PULL_REQUEST_BANDS.map(({ bandKey }) => [bandKey, readField(`${bandKey}Count`)])
      )
    }),
    noMeasuredIssue: null
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
  const bars = weeks.map((week) => {
    const { labelText, noteText, hoverRangeText } = describeWeekAxis(week)
    return {
      barAmount: week.workIssueCount,
      mainText: String(week.workIssueCount),
      subText: null,
      labelText,
      noteText,
      hoverText: `${hoverRangeText}：${week.workIssueCount}件`,
      isHollow: !week.isFullWeek
    }
  })
  return renderVerticalBarChart({ bars, chartTitle: '週ごとの作業 Issue 数' })
}

/**
 * 週ごとの縦棒の図が、棒の下と `<title>` に出す週の表記を作る。週ごとの図どうしで表記がずれないよう、ここ1か所で決める。
 *
 * @param {{ weekStart: string, countedFrom: string, countedTo: string, isFullWeek: boolean }} week 確かめ済みの週
 * @returns {{ labelText: string, noteText: string | null, hoverRangeText: string }} 棒の下の「10/5〜」、全日そろっていない週だけに添える「N日間」、`<title>` と aria-label に使う数えた範囲（全日そろっていない週は日数と注記を含む）
 */
function describeWeekAxis({ weekStart, countedFrom, countedTo, isFullWeek }) {
  const countedDays = countDaysInclusive({ fromDate: countedFrom, toDate: countedTo })
  const countedRange = `${countedFrom}〜${countedTo}`
  return {
    labelText: `${formatMonthDay(weekStart)}〜`,
    noteText: isFullWeek ? null : `${countedDays}日間`,
    hoverRangeText: isFullWeek
      ? countedRange
      : `${countedRange}（${countedDays}日間・全日そろっていない週）`
  }
}

/**
 * 週ごとのマージした PR を、人間レビューの対象と対象外の積み上げ棒にする。棒の上に対象の割合を出し、凡例を添える。
 *
 * @param {Parameters<typeof buildReviewBar>[0][]} weeks 確かめ済みの週（1件以上）。マージした PR が1件以上ある期間のときだけ呼ぶ（0件のときの文言は、ひな形の `if:noMergedPullRequest` が持つ）
 * @returns {string} svg 要素の HTML
 */
function buildReviewFigure(weeks) {
  return renderVerticalBarChart({
    bars: weeks.map(buildReviewBar),
    chartTitle: '週ごとの人間レビュー対象の割合',
    legendItems: [REVIEW_TARGET_LEGEND_ITEM, REVIEW_NON_TARGET_LEGEND_ITEM]
  })
}

/**
 * @param {{ weekStart: string, countedFrom: string, countedTo: string, isFullWeek: boolean, humanReviewTargets: { mergedPullRequestCount: number, targetCount: number } }} week 確かめ済みの週
 * @returns {VerticalBar} renderVerticalBarChart に渡す、積み上げの棒1本。その週にマージした PR が0件なら、棒は描かず「0件」だけを出す
 */
function buildReviewBar(week) {
  const { labelText, noteText, hoverRangeText } = describeWeekAxis(week)
  const { mergedPullRequestCount, targetCount } = week.humanReviewTargets
  const nonTargetCount = mergedPullRequestCount - targetCount
  // 棒の量は段の合計で決まる。マージした PR が0件の週は、2段とも0で、棒の高さも0になる
  const barBase = {
    labelText,
    noteText,
    stackedSegments: [
      { segmentAmount: targetCount, fillColor: REVIEW_TARGET_LEGEND_ITEM.fillColor },
      { segmentAmount: nonTargetCount, fillColor: REVIEW_NON_TARGET_LEGEND_ITEM.fillColor }
    ]
  }
  if (mergedPullRequestCount === 0) {
    return {
      ...barBase,
      mainText: '0件',
      subText: null,
      hoverText: `${hoverRangeText}：マージした PR 0件`
    }
  }
  const percentText = formatPercentText({ count: targetCount, totalCount: mergedPullRequestCount })
  return {
    ...barBase,
    mainText: percentText,
    subText: `${targetCount}/${mergedPullRequestCount}`,
    hoverText: `${hoverRangeText}：マージした PR ${mergedPullRequestCount}件のうち対象${targetCount}件（${percentText}）・対象外${nonTargetCount}件`
  }
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
    const percentText = formatPercentText({
      count: bandCount,
      totalCount: mergedPullRequestCount
    })
    return {
      barAmount: bandCount,
      mainText: String(bandCount),
      subText: percentText,
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
 * 作業 Issue を AI 単独・共同・人間単独・分類なしに分けた件数を、横棒の図にする。
 * 共同が0件のときは棒の代わりに、対話で作った成果物が無いと添える。
 *
 * @param {{ workIssueCount: number, delegationCounts: Record<string, number> }} delegation 作業 Issue の件数（1以上）と、DELEGATION_ROWS の delegationCategory ごとの件数
 * @returns {string} svg 要素の HTML
 */
function buildDelegationFigure({ workIssueCount, delegationCounts }) {
  const bars = DELEGATION_ROWS.map(
    ({ delegationCategory, categoryName, categoryDescription, zeroCountNoteText }) => {
      const barAmount = delegationCounts[delegationCategory]
      const percentText = formatPercentText({ count: barAmount, totalCount: workIssueCount })
      const trailingText = barAmount === 0 && zeroCountNoteText ? zeroCountNoteText : percentText
      return {
        barAmount,
        categoryName,
        categoryDescription,
        countText: `${barAmount}件`,
        trailingText,
        hoverText: `${categoryName}（${categoryDescription}）：${barAmount}件・${trailingText}`
      }
    }
  )
  return renderHorizontalBarChart({ bars, chartTitle: 'AIへの委譲度' })
}

/**
 * 着手から PR が出るまでの時間を5つの帯の縦棒にし、図の上に中央値と1時間未満の大きな数字を置く。
 * 止まっていた時間として読む帯（isStopped）は、薄い灰色の面（backdrop）の上に白抜きの棒で描き、面の上部に注記を添える。
 *
 * @param {{ measuredIssueCount: number, medianMinutes: number | null, underOneHourCount: number, bandCounts: Record<string, number> }} speed 測れた Issue の件数（1以上）、中央値（分）、1時間未満の件数、TIME_TO_PULL_REQUEST_BANDS の bandKey ごとの件数
 * @returns {string} svg 要素の HTML
 */
function buildSpeedFigure({ measuredIssueCount, medianMinutes, underOneHourCount, bandCounts }) {
  const bars = TIME_TO_PULL_REQUEST_BANDS.map(({ bandKey, labelText, isStopped = false }) => {
    const barAmount = bandCounts[bandKey]
    const percentText = formatPercentText({ count: barAmount, totalCount: measuredIssueCount })
    return {
      barAmount,
      mainText: String(barAmount),
      subText: percentText,
      labelText,
      noteText: null,
      hoverText: `${labelText}：${barAmount}件（${percentText}）`,
      isHollow: isStopped
    }
  })
  const underOneHourPercentText = formatPercentText({
    count: underOneHourCount,
    totalCount: measuredIssueCount
  })
  return renderVerticalBarChart({
    bars,
    chartTitle: 'Issue１つあたりのリードタイム分布',
    headlineNumbers: [
      {
        labelText: '中央値',
        valueText: formatNumber(medianMinutes) ?? MISSING_VALUE_TEXT,
        unitText: '分'
      },
      {
        labelText: '1時間未満',
        valueText: underOneHourPercentText,
        unitText: `（${underOneHourCount}件）`
      }
    ],
    backdrop: {
      barPosition: TIME_TO_PULL_REQUEST_BANDS.findIndex(({ isStopped }) => isStopped),
      noteLines: STOPPED_BAND_NOTE_LINES
    }
  })
}

/**
 * 縦棒の図の棒1本。1色の棒（barAmount と isHollow を持つ）か、積み上げの棒（stackedSegments を持つ）のどちらか。
 * 積み上げの棒は、量を段の量の合計で表す。barAmount と段の合計が食い違う棒や、使われない isHollow を持つ棒を作れないようにするため、積み上げの棒は barAmount と isHollow を持たない。
 *
 * @typedef {{ mainText: string, subText: string | null, labelText: string, noteText: string | null, hoverText: string } & ({ barAmount: number, isHollow: boolean } | { stackedSegments: { segmentAmount: number, fillColor: string }[] })} VerticalBar
 */

/**
 * 棒の高さを最大の棒に対する比で決める縦棒の図を描く。
 *
 * @param {{ bars: VerticalBar[], chartTitle: string, headlineNumbers?: { labelText: string, valueText: string, unitText: string }[], legendItems?: { labelText: string, fillColor: string }[], backdrop?: { barPosition: number, noteLines: string[] } | null }} chart 左から並べる棒（1本以上。棒の量は0以上。subText があれば mainText の下に小さく重ねる。1色の棒は黒で、isHollow なら白抜き。積み上げの棒は、下から積む段（量が0の段は描かない）で塗り分け、isHollow は使わない）と、図の題（aria-label の頭に付く）と、図の上に大きな数字で並べる項目と、図の上に並べる凡例（どちらも省くと帯を取らない）と、面を敷く棒の位置（0 から）と面の上部に書く注記（図に1つまで。省くと面を敷かない）
 * @returns {string} svg 要素の HTML。棒が増えても文字が重ならないよう、viewBox の幅を広げる。大きな数字や凡例を並べるときは、図の上にそれぞれの専用の帯（CHART_HEADLINE_BAND_HEIGHT・CHART_LEGEND_BAND_HEIGHT）を上から順に足し、面の注記を取るときはその下に注記の帯を足す。viewBox の高さもその分伸ばし、基準線と棒を下げる
 */
function renderVerticalBarChart({
  bars,
  chartTitle,
  headlineNumbers = [],
  legendItems = [],
  backdrop = null
}) {
  const { chartWidth, barCenterXs, barHeights } = measureVerticalBarLayout(bars)
  const barElements = bars.map((bar, barPosition) =>
    renderBar({ bar, centerX: barCenterXs[barPosition], barHeight: barHeights[barPosition] })
  )
  const headlineBandHeight = headlineNumbers.length > 0 ? CHART_HEADLINE_BAND_HEIGHT : 0
  const topBandHeight = headlineBandHeight + (legendItems.length > 0 ? CHART_LEGEND_BAND_HEIGHT : 0)
  const backdropNoteBandHeight =
    backdrop === null ? 0 : measureBackdropNoteBandHeight(backdrop.noteLines)
  const plotTopOffset = topBandHeight + backdropNoteBandHeight
  const plotElements = [
    // 面は基準線と棒より先に敷く。後に敷くと、基準線と棒を隠す
    backdrop === null
      ? ''
      : renderBackdrop({
          backdrop,
          centerX: barCenterXs[backdrop.barPosition],
          chartWidth,
          noteBandHeight: backdropNoteBandHeight
        }),
    `<line x1="${CHART_MARGIN_X}" y1="${CHART_BASELINE_Y}" x2="${formatCoordinate(chartWidth - CHART_MARGIN_X)}" y2="${CHART_BASELINE_Y}" style="stroke:${CHART_BASELINE_COLOR}" />`,
    ...barElements
  ]
  // 帯の無い図（週ごとの作業 Issue 数の図）の svg を変えないよう、帯があるときだけ包んで下げる
  const plotGroup =
    plotTopOffset === 0
      ? plotElements
      : [`<g transform="translate(0 ${plotTopOffset})">`, ...plotElements, '</g>']
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 ${formatCoordinate(chartWidth)} ${CHART_HEIGHT + plotTopOffset}" role="img" aria-label="${escapeHtml(buildVerticalChartAriaLabel({ chartTitle, headlineNumbers, bars }))}">`,
    ...headlineNumbers.map((headlineNumber, numberPosition) =>
      renderHeadlineNumber({ headlineNumber, numberPosition })
    ),
    ...legendItems.map((legendItem, legendPosition) =>
      renderLegendItem({ legendItem, legendPosition, bandTopY: headlineBandHeight })
    ),
    ...plotGroup,
    '</svg>'
  ].join('')
}

/**
 * @param {VerticalBar[]} bars 左から並べる棒（1本以上）
 * @returns {{ chartWidth: number, barCenterXs: number[], barHeights: number[] }} 図の幅（viewBox の幅）と、棒ごとの中心の x と高さ（0 以上）。棒が増えても文字が重ならないよう、列の幅には下限を置いて図の幅を広げる。高さは、最大の棒を CHART_MAX_BAR_HEIGHT とした比で決める
 */
function measureVerticalBarLayout(bars) {
  const columnWidth = Math.max(
    CHART_MIN_COLUMN_WIDTH,
    (CHART_BASE_WIDTH - 2 * CHART_MARGIN_X) / bars.length
  )
  const barAmounts = bars.map(measureBarAmount)
  // 全部の棒が 0 のときも、0 で割らずに縮尺を決める
  const largestBarAmount = Math.max(1, ...barAmounts)
  return {
    chartWidth: 2 * CHART_MARGIN_X + columnWidth * bars.length,
    barCenterXs: bars.map(
      (_bar, barPosition) => CHART_MARGIN_X + columnWidth * (barPosition + 0.5)
    ),
    barHeights: barAmounts.map((barAmount) => (barAmount / largestBarAmount) * CHART_MAX_BAR_HEIGHT)
  }
}

/**
 * @param {{ chartTitle: string, headlineNumbers: { labelText: string, valueText: string, unitText: string }[], bars: { hoverText: string }[] }} chartContent 図の題と、図に出す大きな数字・棒
 * @returns {string} 図の題に続けて、大きな数字と棒の hoverText（図に出す全部の数字）を並べた aria-label の文字列
 */
function buildVerticalChartAriaLabel({ chartTitle, headlineNumbers, bars }) {
  const headlineTexts = headlineNumbers.map(
    ({ labelText, valueText, unitText }) => `${labelText}${valueText}${unitText}`
  )
  return `${chartTitle}：${[...headlineTexts, ...bars.map(({ hoverText }) => hoverText)].join('／')}`
}

/**
 * @param {VerticalBar} bar 縦棒の図の棒
 * @returns {number} 棒の高さを決める量。積み上げの棒は段の量の合計で、1色の棒は barAmount
 */
function measureBarAmount(bar) {
  return 'stackedSegments' in bar
    ? bar.stackedSegments.reduce((sum, { segmentAmount }) => sum + segmentAmount, 0)
    : bar.barAmount
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
 * @param {string[]} noteLines 面の上部に書く注記の行
 * @returns {number} 注記を収める帯の高さ（1行目の文字の下端、行の間隔、下の余白の合計）。注記が増えると高くなる
 */
function measureBackdropNoteBandHeight(noteLines) {
  return (
    CHART_BACKDROP_NOTE_FIRST_BASELINE_Y +
    CHART_BACKDROP_NOTE_LINE_HEIGHT * (noteLines.length - 1) +
    CHART_BACKDROP_NOTE_BOTTOM_PADDING
  )
}

/**
 * 棒の後ろに薄い灰色の面を敷き、面の上部に注記を書く。面は棒の列の幅より広くなることがあり、注記の最も長い行が収まる幅まで広げて、図の端に収める。
 *
 * @param {{ backdrop: { noteLines: string[] }, centerX: number, chartWidth: number, noteBandHeight: number }} backdropPlacement 面と注記（noteLines は全角の文字だけで書く。面の幅を、全角1字＝文字の大きさとして見積もるため）、面を敷く棒の中心の x、図の幅、基準線の上に取った注記の帯の高さ
 * @returns {string} rect 要素と注記の text 要素の HTML
 */
function renderBackdrop({ backdrop, centerX, chartWidth, noteBandHeight }) {
  const { noteLines } = backdrop
  // 全角の文字の幅は文字の大きさに等しい
  const widestNoteWidth = Math.max(
    ...noteLines.map((noteLine) => [...noteLine].length * CHART_NOTE_TEXT_STYLE.fontSize)
  )
  const backdropWidth = widestNoteWidth + 2 * CHART_BACKDROP_PADDING_X
  const backdropLeftX = Math.min(
    Math.max(centerX - backdropWidth / 2, CHART_BACKDROP_EDGE_INSET),
    chartWidth - CHART_BACKDROP_EDGE_INSET - backdropWidth
  )
  const backdropTopY = -noteBandHeight
  const backdropHeight = noteBandHeight + CHART_BASELINE_Y + CHART_BACKDROP_EXTENT_BELOW_BASELINE
  const noteElements = noteLines.map((noteLine, noteLinePosition) =>
    renderChartText({
      text: noteLine,
      anchorX: backdropLeftX + backdropWidth / 2,
      baselineY:
        backdropTopY +
        CHART_BACKDROP_NOTE_FIRST_BASELINE_Y +
        CHART_BACKDROP_NOTE_LINE_HEIGHT * noteLinePosition,
      textStyle: CHART_NOTE_TEXT_STYLE
    })
  )
  return [
    `<rect x="${formatCoordinate(backdropLeftX)}" y="${backdropTopY}" width="${formatCoordinate(backdropWidth)}" height="${backdropHeight}" rx="${CHART_BACKDROP_CORNER_RADIUS}" style="fill:${CHART_BACKDROP_FILL}" />`,
    ...noteElements
  ].join('')
}

/**
 * @param {{ legendItem: { labelText: string, fillColor: string }, legendPosition: number, bandTopY: number }} legendPlacement 描く凡例の項目と、左から数えた位置、凡例の帯の上端の y
 * @returns {string} 色の見本（四角）と文字を、左から legendPosition 番目の列に置いた g 要素の HTML
 */
function renderLegendItem({ legendItem, legendPosition, bandTopY }) {
  const { labelText, fillColor } = legendItem
  const swatchLeftX = CHART_MARGIN_X + CHART_LEGEND_COLUMN_WIDTH * legendPosition
  const swatchTopY = bandTopY + CHART_LEGEND_SWATCH_TOP_OFFSET
  return [
    '<g>',
    `<rect x="${formatCoordinate(swatchLeftX)}" y="${formatCoordinate(swatchTopY)}" width="${CHART_LEGEND_SWATCH_SIZE}" height="${CHART_LEGEND_SWATCH_SIZE}" rx="${CHART_LEGEND_SWATCH_CORNER_RADIUS}" style="fill:${fillColor}" />`,
    renderChartText({
      text: labelText,
      anchorX: swatchLeftX + CHART_LEGEND_SWATCH_SIZE + CHART_LEGEND_TEXT_GAP_AFTER_SWATCH,
      // 文字の下端を見本の下端より1px上に置くと、見本と文字の中心が目で合う
      baselineY: swatchTopY + CHART_LEGEND_SWATCH_SIZE - 1,
      textStyle: CHART_LEGEND_TEXT_STYLE,
      textAnchor: 'start'
    }),
    '</g>'
  ].join('')
}

/**
 * @param {{ bar: VerticalBar, centerX: number, barHeight: number }} barPlacement 描く棒と、棒の中心の x、棒の高さ（0 以上）
 * @returns {string} 棒・棒の上の文字・棒の下の文字をまとめた g 要素の HTML。マウスを載せると hoverText が出る
 */
function renderBar({ bar, centerX, barHeight }) {
  const { labelText, noteText, hoverText, isHollow, stackedSegments } = bar
  const noteElement =
    noteText === null
      ? ''
      : renderChartText({
          text: noteText,
          anchorX: centerX,
          baselineY: CHART_BASELINE_Y + CHART_NOTE_OFFSET_BELOW_BASELINE,
          textStyle: CHART_NOTE_TEXT_STYLE
        })
  return [
    '<g>',
    `<title>${escapeHtml(hoverText)}</title>`,
    // 0 件の棒は高さが無く、角を丸める道筋も組めない。棒は描かず、棒の上の文字だけを基準線の上に出す
    barHeight > 0 ? renderBarBody({ stackedSegments, centerX, barHeight, isHollow }) : '',
    renderBarAmountTexts({ bar, centerX, barTopY: CHART_BASELINE_Y - barHeight }),
    renderChartText({
      text: labelText,
      anchorX: centerX,
      baselineY: CHART_BASELINE_Y + CHART_LABEL_OFFSET_BELOW_BASELINE,
      textStyle: CHART_LABEL_TEXT_STYLE
    }),
    noteElement,
    '</g>'
  ].join('')
}

/**
 * @param {{ bar: { mainText: string, subText: string | null }, centerX: number, barTopY: number }} amountPlacement 棒の上の文字、棒の中心の x、棒の上端の y
 * @returns {string} 棒の上に置く主の文字（件数や割合）の text 要素の HTML。subText があれば、主の文字の下に小さく添える
 */
function renderBarAmountTexts({ bar, centerX, barTopY }) {
  const { mainText, subText } = bar
  const lowestBaselineY = barTopY - CHART_MAIN_TEXT_GAP_ABOVE_BAR
  if (subText === null) {
    return renderChartText({
      text: mainText,
      anchorX: centerX,
      baselineY: lowestBaselineY,
      textStyle: CHART_MAIN_TEXT_STYLE
    })
  }
  return [
    renderChartText({
      text: mainText,
      anchorX: centerX,
      baselineY: lowestBaselineY - CHART_SUB_TEXT_LINE_HEIGHT,
      textStyle: CHART_MAIN_TEXT_STYLE
    }),
    renderChartText({
      text: subText,
      anchorX: centerX,
      baselineY: lowestBaselineY,
      textStyle: CHART_SUB_TEXT_STYLE
    })
  ].join('')
}

/**
 * @param {{ stackedSegments?: { segmentAmount: number, fillColor: string }[], centerX: number, barHeight: number, isHollow?: boolean }} barBody 積み上げの段（省くと1色の棒）、棒の中心の x、棒の高さ（0 より大きい）、白抜きにするか（1色の棒だけ。積み上げの棒は渡さない）
 * @returns {string} 棒の path 要素の HTML。積み上げの棒では、段ごとの path 要素をつないだもの
 */
function renderBarBody({ stackedSegments, centerX, barHeight, isHollow }) {
  return stackedSegments === undefined
    ? renderBarShape({ centerX, barHeight, isHollow })
    : renderStackedBarShape({ stackedSegments, centerX, barHeight })
}

/**
 * @param {{ centerX: number, barHeight: number, isHollow: boolean }} barShape 棒の中心の x、棒の高さ（0 より大きい）、白抜きにするか
 * @returns {string} 上の角が丸い棒の path 要素。白抜きなら黒の枠だけ、そうでなければ黒で塗る
 */
function renderBarShape({ centerX, barHeight, isHollow }) {
  const leftX = centerX - CHART_BAR_WIDTH / 2
  const outline = buildRoundedTopOutline({
    leftX,
    rightX: leftX + CHART_BAR_WIDTH,
    bottomY: CHART_BASELINE_Y,
    topY: CHART_BASELINE_Y - barHeight,
    cornerRadius: CHART_BAR_CORNER_RADIUS
  })
  const paint = isHollow
    ? `style="fill:${CHART_HOLLOW_FILL};stroke:${CHART_INK_COLOR};stroke-width:${CHART_HOLLOW_STROKE_WIDTH}"`
    : `style="fill:${CHART_INK_COLOR}"`
  return `<path d="${outline}" ${paint} />`
}

/**
 * 量が0より大きい段だけを、下から積んで塗り分ける。角を丸めるのは一番上の段だけ。段と段の間には隙間を空ける。
 *
 * @param {{ stackedSegments: { segmentAmount: number, fillColor: string }[], centerX: number, barHeight: number }} stackedBar 下から並べた段（量が0より大きい段が1つ以上）、棒の中心の x、棒全体の高さ（0 より大きい）
 * @returns {string} 段ごとの path 要素をつないだ HTML。段の高さは、段の量が合計に占める比で決める
 */
function renderStackedBarShape({ stackedSegments, centerX, barHeight }) {
  const drawnSegments = stackedSegments.filter(({ segmentAmount }) => segmentAmount > 0)
  const totalAmount = drawnSegments.reduce((sum, { segmentAmount }) => sum + segmentAmount, 0)
  const leftX = centerX - CHART_BAR_WIDTH / 2
  const segmentPaths = []
  let lowerEdgeY = CHART_BASELINE_Y
  for (const [segmentPosition, { segmentAmount, fillColor }] of drawnSegments.entries()) {
    const isBottomSegment = segmentPosition === 0
    const isTopSegment = segmentPosition === drawnSegments.length - 1
    const segmentHeight = (segmentAmount / totalAmount) * barHeight
    const topY = lowerEdgeY - segmentHeight
    // 隙間は、下の段との境の分だけ、この段の下端を上げて作る。棒全体の高さは変わらない
    const bottomY = isBottomSegment
      ? lowerEdgeY
      : lowerEdgeY - Math.min(CHART_STACK_SEGMENT_GAP, segmentHeight / 2)
    const outline = buildRoundedTopOutline({
      leftX,
      rightX: leftX + CHART_BAR_WIDTH,
      bottomY,
      topY,
      cornerRadius: isTopSegment ? CHART_BAR_CORNER_RADIUS : 0
    })
    segmentPaths.push(`<path d="${outline}" style="fill:${fillColor}" />`)
    lowerEdgeY = topY
  }
  return segmentPaths.join('')
}

/**
 * @param {{ leftX: number, rightX: number, bottomY: number, topY: number, cornerRadius: number }} shape 左右の x、下端と上端の y（上端は下端より上）、上の角の丸み（0 なら四角）
 * @returns {string} 上の2つの角だけが丸い四角の path の d 属性
 */
function buildRoundedTopOutline({ leftX, rightX, bottomY, topY, cornerRadius }) {
  // 丸みが高さを超えると、角の曲線が下端より下へ出る
  const radius = Math.min(cornerRadius, bottomY - topY)
  return [
    `M${formatCoordinate(leftX)} ${formatCoordinate(bottomY)}`,
    `V${formatCoordinate(topY + radius)}`,
    `Q${formatCoordinate(leftX)} ${formatCoordinate(topY)} ${formatCoordinate(leftX + radius)} ${formatCoordinate(topY)}`,
    `H${formatCoordinate(rightX - radius)}`,
    `Q${formatCoordinate(rightX)} ${formatCoordinate(topY)} ${formatCoordinate(rightX)} ${formatCoordinate(topY + radius)}`,
    `V${formatCoordinate(bottomY)}`,
    'Z'
  ].join(' ')
}

/**
 * 棒の長さを最大の棒に対する比で決める横棒の図を描く。行は上から並べ、左に分類名と分類の説明、棒の右に件数と添え書きを置く。
 *
 * @param {{ bars: { barAmount: number, categoryName: string, categoryDescription: string, countText: string, trailingText: string, hoverText: string }[], chartTitle: string }} chart 上から並べる行（1行以上。barAmount は棒が表す量で、0 以上）と、図の題（aria-label の頭に付く）
 * @returns {string} svg 要素の HTML
 */
function renderHorizontalBarChart({ bars, chartTitle }) {
  // 全部の棒が 0 のときも、0 で割らずに縮尺を決める
  const largestBarAmount = Math.max(1, ...bars.map(({ barAmount }) => barAmount))
  const rowElements = bars.map((bar, barPosition) =>
    renderHorizontalBarRow({
      bar,
      rowTopY: HORIZONTAL_CHART_PADDING_Y + HORIZONTAL_CHART_ROW_SPACING * barPosition,
      barLength: (bar.barAmount / largestBarAmount) * HORIZONTAL_CHART_MAX_BAR_LENGTH
    })
  )
  const chartHeight =
    2 * HORIZONTAL_CHART_PADDING_Y +
    HORIZONTAL_CHART_ROW_SPACING * (bars.length - 1) +
    HORIZONTAL_CHART_BAR_THICKNESS
  const ariaLabel = `${chartTitle}：${bars.map(({ hoverText }) => hoverText).join('／')}`
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 ${CHART_BASE_WIDTH} ${formatCoordinate(chartHeight)}" role="img" aria-label="${escapeHtml(ariaLabel)}">`,
    // 棒の始まりに縦の基準線を引く。0 件の行も、始まりの位置が分かる
    `<line x1="${HORIZONTAL_CHART_BAR_START_X}" y1="${HORIZONTAL_CHART_PADDING_Y - HORIZONTAL_CHART_BASELINE_OVERHANG}" x2="${HORIZONTAL_CHART_BAR_START_X}" y2="${formatCoordinate(chartHeight - HORIZONTAL_CHART_PADDING_Y + HORIZONTAL_CHART_BASELINE_OVERHANG)}" style="stroke:${CHART_BASELINE_COLOR}" />`,
    ...rowElements,
    '</svg>'
  ].join('')
}

/**
 * @param {{ bar: { categoryName: string, categoryDescription: string, countText: string, trailingText: string, hoverText: string }, rowTopY: number, barLength: number }} barRow 描く行と、行の上端の y、棒の長さ（0 以上）
 * @returns {string} 棒・分類名・分類の説明・件数をまとめた g 要素の HTML。マウスを載せると hoverText が出る
 */
function renderHorizontalBarRow({ bar, rowTopY, barLength }) {
  const { categoryName, categoryDescription, countText, trailingText, hoverText } = bar
  const rowCenterY = rowTopY + HORIZONTAL_CHART_BAR_THICKNESS / 2
  return [
    '<g>',
    `<title>${escapeHtml(hoverText)}</title>`,
    // 0 件の棒は長さが無く、角を丸める道筋も組めない。件数と添え書きだけを棒の始まりの右に出す
    barLength > 0 ? renderHorizontalBarShape({ rowTopY, barLength }) : '',
    renderChartText({
      text: categoryName,
      anchorX: HORIZONTAL_CHART_TEXT_RIGHT_X,
      baselineY: rowCenterY + HORIZONTAL_CHART_CATEGORY_NAME_OFFSET_FROM_ROW_CENTER,
      textStyle: CHART_CATEGORY_NAME_TEXT_STYLE,
      textAnchor: 'end'
    }),
    renderChartText({
      text: categoryDescription,
      anchorX: HORIZONTAL_CHART_TEXT_RIGHT_X,
      baselineY: rowCenterY + HORIZONTAL_CHART_CATEGORY_DESCRIPTION_OFFSET_FROM_ROW_CENTER,
      textStyle: CHART_CATEGORY_DESCRIPTION_TEXT_STYLE,
      textAnchor: 'end'
    }),
    renderChartText({
      text: countText,
      anchorX: HORIZONTAL_CHART_BAR_START_X + barLength + HORIZONTAL_CHART_TEXT_GAP_AFTER_BAR,
      baselineY: rowCenterY + HORIZONTAL_CHART_COUNT_OFFSET_FROM_ROW_CENTER,
      textStyle: CHART_MAIN_TEXT_STYLE,
      textAnchor: 'start',
      trailing: {
        text: trailingText,
        textStyle: CHART_COUNT_TRAILING_TEXT_STYLE,
        gapX: CHART_COUNT_TRAILING_TEXT_GAP
      }
    }),
    '</g>'
  ].join('')
}

/**
 * @param {{ rowTopY: number, barLength: number }} barShape 行の上端の y と、棒の長さ（0 より大きい）
 * @returns {string} 右の角が丸い棒の path 要素。黒で塗る
 */
function renderHorizontalBarShape({ rowTopY, barLength }) {
  const leftX = HORIZONTAL_CHART_BAR_START_X
  const rightX = leftX + barLength
  const bottomY = rowTopY + HORIZONTAL_CHART_BAR_THICKNESS
  // 丸みが棒の長さや太さの半分を超えると、角の曲線が棒の外へ出る
  const cornerRadius = Math.min(
    CHART_BAR_CORNER_RADIUS,
    barLength,
    HORIZONTAL_CHART_BAR_THICKNESS / 2
  )
  const outline = [
    `M${formatCoordinate(leftX)} ${formatCoordinate(rowTopY)}`,
    `H${formatCoordinate(rightX - cornerRadius)}`,
    `Q${formatCoordinate(rightX)} ${formatCoordinate(rowTopY)} ${formatCoordinate(rightX)} ${formatCoordinate(rowTopY + cornerRadius)}`,
    `V${formatCoordinate(bottomY - cornerRadius)}`,
    `Q${formatCoordinate(rightX)} ${formatCoordinate(bottomY)} ${formatCoordinate(rightX - cornerRadius)} ${formatCoordinate(bottomY)}`,
    `H${formatCoordinate(leftX)}`,
    'Z'
  ].join(' ')
  return `<path d="${outline}" style="fill:${CHART_INK_COLOR}" />`
}

/**
 * @param {{ text: string, anchorX: number, baselineY: number, textStyle: { fontSize: number, fontWeight: number, color: string, fontFamily?: string }, textAnchor?: 'start' | 'middle' | 'end', trailing?: { text: string, textStyle: { fontSize: number, fontWeight: number, color: string }, gapX: number } | null }} chartText 文字と、寄せる位置の x、文字の下端の y、見た目。textStyle の fontFamily は、省くとページの書体になる（等幅にするときに渡す）。textAnchor は anchorX に対する寄せ方（start は左寄せ、end は右寄せ。既定は中央）。trailing は text の直後に、gapX だけ空けて続ける文字（既定は無し）
 * @returns {string} text 要素の HTML
 */
function renderChartText({
  text,
  anchorX,
  baselineY,
  textStyle,
  textAnchor = 'middle',
  trailing = null
}) {
  // 後ろに続ける文字は、前の文字の幅を測らずに済むよう、同じ text 要素の tspan にして dx だけ空ける
  const trailingElement =
    trailing === null
      ? ''
      : `<tspan dx="${trailing.gapX}" font-size="${trailing.textStyle.fontSize}" font-weight="${trailing.textStyle.fontWeight}" style="fill:${trailing.textStyle.color}">${escapeHtml(trailing.text)}</tspan>`
  const { fontSize, fontWeight, color, fontFamily } = textStyle
  const fontFamilyStyle = fontFamily === undefined ? '' : `;font-family:${fontFamily}`
  return `<text x="${formatCoordinate(anchorX)}" y="${formatCoordinate(baselineY)}" text-anchor="${textAnchor}" font-size="${fontSize}" font-weight="${fontWeight}" style="fill:${color}${fontFamilyStyle}">${escapeHtml(text)}${trailingElement}</text>`
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
 * @param {{ count: number, totalCount: number }} ratio 部分の件数と全体の件数（全体は1以上）
 * @returns {string} 図の棒や行に添える「45%」の形の割合。全体が 0 件だと formatPercent が null を返し「null%」になるので、全体が 0 件の図は呼び出し側が描かない
 */
function formatPercentText(ratio) {
  return `${formatPercent(ratio)}%`
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
