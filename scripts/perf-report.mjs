#!/usr/bin/env node
// 責務: 指定した期間に完了した作業 Issue を、日本時間の月曜始まりの週ごとと委譲の分類ごとに数え、
//   同じ期間にマージした PR の差分行数を帯ごとに数え、人間レビューの対象の件数を全体と週ごとに数え、
//   AI 単独の Issue の着手から PR が出るまでの時間をまとめ、作業 Issue とマージした PR の1件ごとの記録を添えて、JSON で標準出力に返す。
//   `/perf-report` はこの結果をファイルに保存し、会話中の AI がそれを読んで考察ファイルを書く。
//   `scripts/perf-report-html.mjs` が、保存した結果と考察ファイルでひな形を埋めて HTML 1枚にする。
//
// 設計意図（WHY）:
// - 数える処理をスクリプトに置く。報告の数字は誰が打っても同じでなければならず、AI に数えさせると打つたびにぶれる。
// - 検索は週ごとに分けて打つ。GitHub の検索は1回で 1000 件までしか返さないので、期間をまとめて打つと、長い期間で黙って欠ける。
//   それでも 1000 件を超える週は、欠けたまま数えず失敗にする。
// - 委譲の分類はラベルだけで決める。他のリポジトリでも同じ Skill が使えるようにするためである（#1591）。
//   無人実行の記録（runs.jsonl）は使わない。無人実行の定義に問題があり、端末ごとの記録でもある。
// - 差分行数の帯は docs/policy/pr-review-policy.md「見積もりで割る線」の 200行・300行に合わせる（#1592）。
// - 人間レビューの対象は、PR に付いた `needs-human-review` で数える（#1603）。`.github/workflows/pr-ai-triage.yml` が付けるので、新しい記録は要らない。
//   このラベルは「レビューすべき」の印であり、人間が読んだ記録ではない。
// - 着手から PR が出るまでの時間は、最初の `In Review` の直前の `In progress` から測る（#1608）。無人実行が失敗するとカードが `In progress` に残り、
//   最初の `In progress` から測ると再実行までの止まっていた時間が入るためである。測り終わりを `In Review` にするのは、人間のレビュー待ちを入れないためである。
// - Status 履歴は Issue の検索に入れず、25 件ずつ別に引く。検索や 100 件の別名に入れると、エラーを返さず一部の Issue の履歴だけが空で返る（#1608。原因は未確認）。
//   278 件で確かめると、1回 100 件では 62 件が空になり、1・10・25・50 件では同じ結果だった。25 件は 50 件に余裕を持たせた値である。
// - Status 履歴は Issue ごとに先頭の 100 件だけ読む。最初の `In Review` までに 100 回も動いた Issue は想定しない。
// - 1件ごとの記録（workIssueRecords・mergedPullRequestRecords）は、AI が考察で「なぜ」を書く材料である（#1685）。
//   帯ごとの件数だけでは、どの作業がその値になったかが分からない。何の作業かはタイトルから読む。
//   記録に Issue・PR の番号を入れない。レポートに番号を載せないので、材料にも渡さない。
// - hasProductCode も返す。`/perf-report` は、app/・infra/ にコードが無いときだけ「本番では未検証」と注記する。
// - generatedOn（今日）も返す。`perf-report-html.mjs` が出力のファイル名に使う。
// - 日付は固定幅の文字列のまま大小を比べる。年を 4 桁に収まる範囲へ絞るのはそのためで、外れると週を進めるループが終わらない。
//
// 使い方: npm run --silent perf-report -- [--from YYYY-MM-DD] [--to YYYY-MM-DD] > tmp/perf-report/<日時>-perf-report-aggregate.json
//   日付は日本時間で読む。--to の既定は今日、--from の既定は --to の1か月前である

import { parseArgs } from 'node:util'

import { runJson, runOrThrow } from './auto-programmer/shell.mjs'
import { BusinessError, TechnicalError } from './lib/errors.mjs'
import {
  EXCLUSION_REASONS,
  EXCLUSION_TARGET_FIELDS,
  HUMAN_REVIEW_LABEL,
  findExclusionReason
} from './lib/work-issues.mjs'

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000
const MILLISECONDS_PER_MINUTE = 60 * 1000
const MINUTES_PER_HOUR = 60
const DAYS_PER_WEEK = 7
const SEARCH_RESULT_LIMIT = 1000
const STATUS_HISTORY_BATCH_SIZE = 25
const MIN_SUPPORTED_YEAR = 1000
const MAX_SUPPORTED_YEAR = 9998

const REPORT_TIMEZONE_NAME = 'Asia/Tokyo'
const REPORT_UTC_OFFSET = '+09:00'
const REPORT_UTC_OFFSET_MILLISECONDS = 9 * 60 * 60 * 1000

const AI_FIXABLE_LABEL = 'ai-fixable'
const READY_FOR_HUMAN_LABEL = 'ready-for-human'
const COLLABORATION_LABEL = 'human-ai-collaboration'
const POLICY_OR_CICD_LABELS = ['policy', 'cicd']

const IN_PROGRESS_STATUS = 'In progress'
const IN_REVIEW_STATUS = 'In Review'

// 上から順に当て、最初に当たった帯だけで数える。最後の帯がすべてを受けるので、帯ごとの件数を足すと PR の件数に一致する
const DIFF_LINE_BANDS = [
  { band: 'under50', maxChangedLines: 49 },
  { band: 'from50To199', maxChangedLines: 199 },
  { band: 'from200To300', maxChangedLines: 300 },
  { band: 'over300', maxChangedLines: Number.POSITIVE_INFINITY }
]

// 時間は小数になるので、上限はその値を含まない（14.5分は 5〜14分の帯に入る）
const PULL_REQUEST_TIME_BANDS = [
  { band: 'under5Minutes', underMinutes: 5 },
  { band: 'from5To14Minutes', underMinutes: 15 },
  { band: 'from15To59Minutes', underMinutes: MINUTES_PER_HOUR },
  { band: 'from1To8Hours', underMinutes: 8 * MINUTES_PER_HOUR },
  { band: 'atLeast8Hours', underMinutes: Number.POSITIVE_INFINITY }
]

const CLOSED_ISSUES_QUERY = `query($searchQuery: String!, $endCursor: String) {
  search(query: $searchQuery, type: ISSUE, first: 100, after: $endCursor) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on Issue {
        number
        title
        ${EXCLUSION_TARGET_FIELDS}
      }
    }
  }
}`

const MERGED_PULL_REQUESTS_QUERY = `query($searchQuery: String!, $endCursor: String) {
  search(query: $searchQuery, type: ISSUE, first: 100, after: $endCursor) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        title
        additions
        deletions
        labels(first: 50) { nodes { name } }
      }
    }
  }
}`

/**
 * @typedef {object} MergedPullRequest
 * @property {string} title タイトル
 * @property {number} additions 追加した行数
 * @property {number} deletions 削除した行数
 * @property {{ nodes: { name: string }[] }} labels ラベル
 */

/**
 * @typedef {object} ClosedIssue
 * @property {number} number Issue 番号
 * @property {string} title タイトル
 * @property {string | null} stateReason close の理由（COMPLETED・NOT_PLANNED・DUPLICATE）
 * @property {string} body 本文
 * @property {{ __typename: string } | null} author 起票者（アカウントが消えていれば null）
 * @property {{ nodes: { name: string }[] }} labels ラベル
 * @property {{ totalCount: number }} subIssues 子 Issue
 */

/**
 * @typedef {object} StatusChange
 * @property {string} createdAt 変わった日時
 * @property {string} status 変わった後のボードの Status
 */

/**
 * @typedef {object} StatusHistory
 * @property {number} issueNumber Issue 番号
 * @property {StatusChange[]} statusChanges Status の変更（古い順）
 */

/**
 * @typedef {object} WorkIssue
 * @property {number} number Issue 番号
 * @property {string} title タイトル
 * @property {string} delegationCategory 委譲の分類
 * @property {string} closedWeekStart close された週の月曜日（YYYY-MM-DD）
 */

// 上から順に当て、最初に当たった分類だけで数える。最後の分類がすべてを受けるので、分類ごとの件数を足すと作業 Issue の件数に一致する。
// 共同は人間単独より先に当てる。共同の Issue は `ready-for-human` も持つためである
const DELEGATION_RULES = [
  { category: 'aiOnly', matches: (issue) => hasAnyLabel(issue, [AI_FIXABLE_LABEL]) },
  {
    category: 'collaboration',
    matches: (issue) =>
      hasAnyLabel(issue, [READY_FOR_HUMAN_LABEL]) && hasAnyLabel(issue, [COLLABORATION_LABEL])
  },
  { category: 'humanOnly', matches: (issue) => hasAnyLabel(issue, [READY_FOR_HUMAN_LABEL]) },
  { category: 'unclassified', matches: () => true }
]

/**
 * CLI として実行したときの本体。集計結果を JSON で標準出力に返す。
 *
 * @returns {void}
 * @throws {BusinessError} 期間の引数が不正なとき
 * @throws {TechnicalError} gh・git が失敗したとき・検索の上限を超えて数え切れないとき
 */
function runCli() {
  const today = getTodayInReportTimezone()
  const { from, to } = parsePeriod(process.argv.slice(2), today)
  const repository = readCurrentRepository()
  const weeklyTallies = fetchWeeklyTallies({ repository, from, to })
  const pullRequests = weeklyTallies.flatMap((weeklyTally) => weeklyTally.pullRequests)
  const workIssues = weeklyTallies.flatMap(({ week, tally }) =>
    tally.workIssues.map((workIssue) => ({ ...workIssue, closedWeekStart: week.weekStart }))
  )
  const statusHistories = fetchStatusHistories({
    repository,
    issueNumbers: workIssues
      .filter(({ delegationCategory }) => delegationCategory === 'aiOnly')
      .map(({ number }) => number)
  })
  const report = {
    ...buildReport({ repository, from, to, today, weeklyTallies }),
    pullRequestDiffLines: summarizeChangedLines(pullRequests.map(countChangedLines)),
    humanReviewTargets: {
      ...summarizeHumanReviewTargets(pullRequests),
      policyOrCicdCount: countPolicyOrCicdTargets(pullRequests)
    },
    aiOnlyTimeToPullRequest: summarizeTimeToPullRequest(
      statusHistories.map(({ statusChanges }) => statusChanges)
    ),
    workIssueRecords: buildWorkIssueRecords({ workIssues, statusHistories }),
    mergedPullRequestRecords: buildMergedPullRequestRecords(weeklyTallies)
  }
  console.log(JSON.stringify(report, null, 2))
}

/**
 * 期間を週に分け、週ごとに close された Issue を数え、マージされた PR を引く。
 *
 * @param {{ repository: string, from: string, to: string }} searchRange 対象のリポジトリ（owner/repo）と、期間の初日・最終日（YYYY-MM-DD）
 * @returns {{ week: { weekStart: string, weekEnd: string, countedFrom: string, countedTo: string }, tally: ReturnType<typeof tallyIssues>, pullRequests: MergedPullRequest[] }[]} 週ごとの集計
 * @throws {TechnicalError} gh が失敗したとき・検索の上限を超えて数え切れないとき
 */
function fetchWeeklyTallies({ repository, from, to }) {
  return splitIntoWeeks({ from, to }).map((week) => ({
    week,
    tally: tallyIssues(
      fetchClosedIssues({ repository, from: week.countedFrom, to: week.countedTo })
    ),
    pullRequests: fetchMergedPullRequests({
      repository,
      from: week.countedFrom,
      to: week.countedTo
    })
  }))
}

/**
 * コマンドラインの引数から期間を決める。
 *
 * @param {string[]} commandLineArguments `--from`・`--to` を含む引数
 * @param {string} today 今日（YYYY-MM-DD）。引数を省いたときの既定値に使う
 * @returns {{ from: string, to: string }} 期間の初日と最終日
 * @throws {BusinessError} 引数が読めないとき・日付が対応範囲の外か実在しないとき・初日が最終日より後のとき
 */
function parsePeriod(commandLineArguments, today) {
  const { values } = parsePeriodOptions(commandLineArguments)
  const to = values.to ?? today
  assertSupportedDate(to)
  const from = values.from ?? findOneMonthBefore(to)
  assertSupportedDate(from)
  if (from > to) throw new BusinessError(`--from が --to より後です: ${from} > ${to}`)
  return { from, to }
}

/**
 * @param {string[]} commandLineArguments コマンドラインの引数
 * @returns {{ values: { from?: string, to?: string } }} 読み取った引数
 * @throws {BusinessError} 知らない引数があるとき・値が無いとき
 */
function parsePeriodOptions(commandLineArguments) {
  try {
    return parseArgs({
      args: commandLineArguments,
      options: { from: { type: 'string' }, to: { type: 'string' } }
    })
  } catch (error) {
    throw new BusinessError(error.message, { cause: error })
  }
}

/**
 * @param {string} date 検査する文字列
 * @returns {void}
 * @throws {BusinessError} YYYY-MM-DD の形でないとき・実在しないとき・対応する年の範囲の外のとき
 */
function assertSupportedDate(date) {
  if (isSupportedDate(date)) return
  throw new BusinessError(
    `日付は ${MIN_SUPPORTED_YEAR}〜${MAX_SUPPORTED_YEAR} 年の YYYY-MM-DD で渡してください: ${date}`
  )
}

/**
 * @param {string} date 検査する文字列
 * @returns {boolean} 対応する年の範囲で実在する日付を YYYY-MM-DD で書いていれば true
 */
function isSupportedDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false
  const year = Number(date.slice(0, 4))
  if (year < MIN_SUPPORTED_YEAR || year > MAX_SUPPORTED_YEAR) return false
  const parsedDate = new Date(`${date}T00:00:00Z`)
  return !Number.isNaN(parsedDate.getTime()) && formatDate(parsedDate) === date
}

/**
 * 期間を、月曜始まりの週に分ける。
 *
 * @param {{ from: string, to: string }} period 期間の初日と最終日（YYYY-MM-DD）
 * @returns {{ weekStart: string, weekEnd: string, countedFrom: string, countedTo: string }[]} 週と、そのうち数える範囲
 */
function splitIntoWeeks({ from, to }) {
  const weeks = []
  for (let weekStart = findMonday(from); weekStart <= to;) {
    const weekEnd = addDays(weekStart, DAYS_PER_WEEK - 1)
    weeks.push({
      weekStart,
      weekEnd,
      countedFrom: weekStart < from ? from : weekStart,
      countedTo: weekEnd > to ? to : weekEnd
    })
    weekStart = addDays(weekStart, DAYS_PER_WEEK)
  }
  return weeks
}

/**
 * 日本時間の範囲に close された Issue を引く。
 *
 * @param {{ repository: string, from: string, to: string }} searchRange 対象のリポジトリ（owner/repo）と、範囲の初日・最終日（YYYY-MM-DD）
 * @returns {ClosedIssue[]} close された Issue
 * @throws {TechnicalError} gh が失敗したとき・検索の上限を超えて数え切れないとき
 */
function fetchClosedIssues({ repository, from, to }) {
  return searchAllNodes({
    graphqlQuery: CLOSED_ISSUES_QUERY,
    searchQuery: `repo:${repository} is:issue is:closed closed:${formatSearchRange(from, to)}`,
    period: { from, to }
  })
}

/**
 * 日本時間の範囲にマージされた PR を引く。
 *
 * @param {{ repository: string, from: string, to: string }} searchRange 対象のリポジトリ（owner/repo）と、範囲の初日・最終日（YYYY-MM-DD）
 * @returns {MergedPullRequest[]} マージされた PR
 * @throws {TechnicalError} gh が失敗したとき・検索の上限を超えて数え切れないとき
 */
function fetchMergedPullRequests({ repository, from, to }) {
  return searchAllNodes({
    graphqlQuery: MERGED_PULL_REQUESTS_QUERY,
    searchQuery: `repo:${repository} is:pr is:merged merged:${formatSearchRange(from, to)}`,
    period: { from, to }
  })
}

/**
 * Issue ごとのボードの Status 履歴を引く。
 *
 * @param {{ repository: string, issueNumbers: number[] }} target 対象のリポジトリ（owner/repo）と Issue 番号
 * @returns {StatusHistory[]} Issue ごとの Status の変更。渡した Issue 番号と同じ順・同じ件数で並ぶ
 * @throws {TechnicalError} gh が失敗したとき
 */
function fetchStatusHistories({ repository, issueNumbers }) {
  const [repositoryOwner, repositoryName] = repository.split('/')
  const statusHistories = []
  for (let start = 0; start < issueNumbers.length; start += STATUS_HISTORY_BATCH_SIZE) {
    const batchNumbers = issueNumbers.slice(start, start + STATUS_HISTORY_BATCH_SIZE)
    const statusHistoryResponse = runJson('gh', [
      'api',
      'graphql',
      '-f',
      `query=${buildStatusHistoryQuery(batchNumbers)}`,
      '-f',
      `owner=${repositoryOwner}`,
      '-f',
      `name=${repositoryName}`
    ])
    for (const issueNumber of batchNumbers) {
      const { timelineItems } = statusHistoryResponse.data.repository[`issue${issueNumber}`]
      statusHistories.push({ issueNumber, statusChanges: timelineItems.nodes })
    }
  }
  return statusHistories
}

/**
 * @param {number[]} issueNumbers 引く Issue の番号
 * @returns {string} 指定した Issue の Status 履歴を1回で引く GraphQL の問い合わせ
 */
function buildStatusHistoryQuery(issueNumbers) {
  const issueFields = issueNumbers.map(
    (issueNumber) => `issue${issueNumber}: issue(number: ${issueNumber}) {
      timelineItems(itemTypes: [PROJECT_V2_ITEM_STATUS_CHANGED_EVENT], first: 100) {
        nodes { ... on ProjectV2ItemStatusChangedEvent { createdAt status } }
      }
    }`
  )
  return `query($owner: String!, $name: String!) {
    repository(owner: $owner, name: $name) { ${issueFields.join('\n')} }
  }`
}

/**
 * @param {string} from 範囲の初日（YYYY-MM-DD）
 * @param {string} to 範囲の最終日（YYYY-MM-DD）
 * @returns {string} GitHub の検索に渡す、日本時間の日時の範囲
 */
function formatSearchRange(from, to) {
  return `${from}T00:00:00${REPORT_UTC_OFFSET}..${to}T23:59:59${REPORT_UTC_OFFSET}`
}

/**
 * GitHub の検索を最後のページまで引く。
 *
 * @param {{ graphqlQuery: string, searchQuery: string, period: { from: string, to: string } }} search GraphQL の問い合わせ・検索の条件と、エラーに出す範囲
 * @returns {object[]} 当たったものすべて
 * @throws {TechnicalError} gh が失敗したとき・検索の上限を超えて数え切れないとき
 */
function searchAllNodes({ graphqlQuery, searchQuery, period }) {
  const pages = runJson('gh', [
    'api',
    'graphql',
    '--paginate',
    '--slurp',
    '-f',
    `query=${graphqlQuery}`,
    '-f',
    `searchQuery=${searchQuery}`
  ])
  const { issueCount } = pages[0].data.search
  if (issueCount > SEARCH_RESULT_LIMIT) {
    throw new TechnicalError(
      `${period.from}〜${period.to} は ${issueCount} 件あり、検索の上限（${SEARCH_RESULT_LIMIT} 件）を超えるので数え切れません`
    )
  }
  return pages.flatMap((page) => page.data.search.nodes)
}

/**
 * Issue を、作業 Issue・除外の理由ごと・委譲の分類ごとに数える。
 *
 * @param {ClosedIssue[]} issues close された Issue
 * @returns {{ workIssueCount: number, excludedCounts: Record<string, number>, delegationCounts: Record<string, number>, workIssues: Omit<WorkIssue, 'closedWeekStart'>[] }} 作業 Issue の件数と、除外の理由ごと・委譲の分類ごとの件数、作業 Issue の番号・タイトル・委譲の分類
 */
function tallyIssues(issues) {
  const excludedCounts = createEmptyExcludedCounts()
  const delegationCounts = createEmptyDelegationCounts()
  const workIssues = []
  let workIssueCount = 0
  for (const issue of issues) {
    const exclusionReason = findExclusionReason(issue)
    if (exclusionReason) {
      excludedCounts[exclusionReason] += 1
      continue
    }
    workIssueCount += 1
    const delegationCategory = findDelegationCategory(issue)
    delegationCounts[delegationCategory] += 1
    workIssues.push({ number: issue.number, title: issue.title, delegationCategory })
  }
  return { workIssueCount, excludedCounts, delegationCounts, workIssues }
}

/**
 * @param {ClosedIssue} issue 作業 Issue
 * @returns {string} 委譲の分類
 */
function findDelegationCategory(issue) {
  return DELEGATION_RULES.find(({ matches }) => matches(issue)).category
}

/**
 * 週ごとの集計を、出力する形にまとめる。
 *
 * @param {{ repository: string, from: string, to: string, today: string, weeklyTallies: { week: { weekStart: string, weekEnd: string, countedFrom: string, countedTo: string }, tally: ReturnType<typeof tallyIssues>, pullRequests: MergedPullRequest[] }[] }} reportSource 集計の結果と、その条件
 * @returns {object} 標準出力に出す内容
 * @throws {TechnicalError} git が失敗したとき
 */
function buildReport({ repository, from, to, today, weeklyTallies }) {
  const weeks = weeklyTallies.map(({ week, tally, pullRequests }) => ({
    ...week,
    workIssueCount: tally.workIssueCount,
    humanReviewTargets: summarizeHumanReviewTargets(pullRequests),
    isFullWeek: isFullWeek(week, today)
  }))
  const workIssueCount = weeks.reduce((sum, week) => sum + week.workIssueCount, 0)
  const excludedCounts = sumExcludedCounts(weeklyTallies.map(({ tally }) => tally))
  const excludedIssueCount = Object.values(excludedCounts).reduce((sum, count) => sum + count, 0)
  return {
    repository,
    period: { from, to, timezone: REPORT_TIMEZONE_NAME },
    generatedOn: today,
    closedIssueCount: workIssueCount + excludedIssueCount,
    workIssueCount,
    excludedCounts,
    delegationCounts: sumDelegationCounts(weeklyTallies.map(({ tally }) => tally)),
    weeks,
    fullWeekSummary: summarizeFullWeeks(weeks),
    hasProductCode: readHasProductCode()
  }
}

/**
 * @param {{ weekStart: string, weekEnd: string, countedFrom: string, countedTo: string }} week 週と、そのうち数えた範囲
 * @param {string} today 今日（YYYY-MM-DD）
 * @returns {boolean} 週の全日を数え終えていれば true。今日を含む週は、今日がまだ終わっていないので false
 */
function isFullWeek({ weekStart, weekEnd, countedFrom, countedTo }, today) {
  return countedFrom === weekStart && countedTo === weekEnd && weekEnd < today
}

/**
 * @returns {Record<string, number>} 除外の理由ごとの件数をすべて 0 にしたもの
 */
function createEmptyExcludedCounts() {
  return Object.fromEntries(EXCLUSION_REASONS.map((reason) => [reason, 0]))
}

/**
 * @param {{ excludedCounts: Record<string, number> }[]} tallies 週ごとの集計
 * @returns {Record<string, number>} 除外の理由ごとの、全週の合計
 */
function sumExcludedCounts(tallies) {
  const totalCounts = createEmptyExcludedCounts()
  for (const { excludedCounts } of tallies) {
    for (const reason of EXCLUSION_REASONS) totalCounts[reason] += excludedCounts[reason]
  }
  return totalCounts
}

/**
 * @returns {Record<string, number>} 委譲の分類ごとの件数をすべて 0 にしたもの
 */
function createEmptyDelegationCounts() {
  return Object.fromEntries(DELEGATION_RULES.map(({ category }) => [category, 0]))
}

/**
 * @param {{ delegationCounts: Record<string, number> }[]} tallies 週ごとの集計
 * @returns {Record<string, number>} 委譲の分類ごとの、全週の合計
 */
function sumDelegationCounts(tallies) {
  const totalCounts = createEmptyDelegationCounts()
  for (const { delegationCounts } of tallies) {
    for (const { category } of DELEGATION_RULES) totalCounts[category] += delegationCounts[category]
  }
  return totalCounts
}

/**
 * 全日そろった週の件数を、平均と幅にまとめる。
 *
 * @param {{ workIssueCount: number, isFullWeek: boolean }[]} weeks 集計した週
 * @returns {{ weekCount: number, average: number, min: number, max: number } | null} average は小数第1位に四捨五入した値。全日そろった週が無ければ null
 */
function summarizeFullWeeks(weeks) {
  const fullWeekIssueCounts = weeks
    .filter((week) => week.isFullWeek)
    .map((week) => week.workIssueCount)
  if (fullWeekIssueCounts.length === 0) return null
  const totalCount = fullWeekIssueCounts.reduce((sum, count) => sum + count, 0)
  return {
    weekCount: fullWeekIssueCounts.length,
    average: roundToOneDecimal(totalCount / fullWeekIssueCounts.length),
    min: Math.min(...fullWeekIssueCounts),
    max: Math.max(...fullWeekIssueCounts)
  }
}

/**
 * PR の差分行数を、帯ごとの件数と中央値・平均にまとめる。
 *
 * @param {number[]} changedLineCounts PR ごとの追加と削除の合計
 * @returns {{ mergedPullRequestCount: number, bandCounts: Record<string, number>, median: number | null, average: number | null }} median と average は小数第1位に四捨五入した値。PR が無ければ null
 */
function summarizeChangedLines(changedLineCounts) {
  const bandCounts = Object.fromEntries(DIFF_LINE_BANDS.map(({ band }) => [band, 0]))
  for (const changedLines of changedLineCounts) {
    const { band } = DIFF_LINE_BANDS.find(({ maxChangedLines }) => changedLines <= maxChangedLines)
    bandCounts[band] += 1
  }
  const mergedPullRequestCount = changedLineCounts.length
  if (mergedPullRequestCount === 0) {
    return { mergedPullRequestCount, bandCounts, median: null, average: null }
  }
  const totalChangedLines = changedLineCounts.reduce((sum, changedLines) => sum + changedLines, 0)
  return {
    mergedPullRequestCount,
    bandCounts,
    median: roundToOneDecimal(findMedian(changedLineCounts)),
    average: roundToOneDecimal(totalChangedLines / mergedPullRequestCount)
  }
}

/**
 * マージした PR のうち、人間レビューの対象を数える。
 *
 * @param {MergedPullRequest[]} pullRequests マージされた PR
 * @returns {{ mergedPullRequestCount: number, targetCount: number, targetPercentage: number | null }} targetPercentage は小数第1位に四捨五入した百分率。PR が無ければ null
 */
function summarizeHumanReviewTargets(pullRequests) {
  const mergedPullRequestCount = pullRequests.length
  const targetCount = pullRequests.filter((pullRequest) =>
    hasAnyLabel(pullRequest, [HUMAN_REVIEW_LABEL])
  ).length
  const targetPercentage =
    mergedPullRequestCount === 0
      ? null
      : roundToOneDecimal((targetCount / mergedPullRequestCount) * 100)
  return { mergedPullRequestCount, targetCount, targetPercentage }
}

/**
 * @param {MergedPullRequest[]} pullRequests マージされた PR
 * @returns {number} 人間レビューの対象のうち、`policy`・`cicd` のどちらかが付いた PR の件数。両方付いていても1件と数える
 */
function countPolicyOrCicdTargets(pullRequests) {
  return pullRequests.filter(
    (pullRequest) =>
      hasAnyLabel(pullRequest, [HUMAN_REVIEW_LABEL]) &&
      hasAnyLabel(pullRequest, POLICY_OR_CICD_LABELS)
  ).length
}

/**
 * AI 単独の作業 Issue の、着手から PR が出るまでの時間をまとめる。
 *
 * @param {StatusChange[][]} statusHistories AI 単独の作業 Issue ごとの Status の変更
 * @returns {{ targetIssueCount: number, measuredIssueCount: number, bandCounts: Record<string, number>, medianMinutes: number | null, underOneHourCount: number, underOneHourPercentage: number | null }} medianMinutes と underOneHourPercentage は小数第1位に四捨五入した値。測れた Issue が無ければ null
 */
function summarizeTimeToPullRequest(statusHistories) {
  const measuredMinutes = statusHistories
    .map((statusChanges) => measureMinutesToPullRequest(statusChanges))
    .filter((minutes) => minutes !== null)
  const bandCounts = Object.fromEntries(PULL_REQUEST_TIME_BANDS.map(({ band }) => [band, 0]))
  for (const minutes of measuredMinutes) {
    const { band } = PULL_REQUEST_TIME_BANDS.find(({ underMinutes }) => minutes < underMinutes)
    bandCounts[band] += 1
  }
  const measuredIssueCount = measuredMinutes.length
  const underOneHourCount = measuredMinutes.filter((minutes) => minutes < MINUTES_PER_HOUR).length
  const hasMeasuredIssue = measuredIssueCount > 0
  return {
    targetIssueCount: statusHistories.length,
    measuredIssueCount,
    bandCounts,
    medianMinutes: hasMeasuredIssue ? roundToOneDecimal(findMedian(measuredMinutes)) : null,
    underOneHourCount,
    underOneHourPercentage: hasMeasuredIssue
      ? roundToOneDecimal((underOneHourCount / measuredIssueCount) * 100)
      : null
  }
}

/**
 * 作業 Issue の1件ごとの記録を作る。着手から PR が出るまでの時間は、AI 単独で測れた Issue にだけ付ける。
 *
 * @param {{ workIssues: WorkIssue[], statusHistories: StatusHistory[] }} recordSource 作業 Issue と、AI 単独の作業 Issue ごとの Status の変更
 * @returns {{ title: string, closedWeekStart: string, delegationCategory: string, minutesToPullRequest?: number }[]} close された順の記録。minutesToPullRequest は小数第1位に四捨五入した分
 */
function buildWorkIssueRecords({ workIssues, statusHistories }) {
  const minutesByIssueNumber = new Map(
    statusHistories.map(({ issueNumber, statusChanges }) => [
      issueNumber,
      measureMinutesToPullRequest(statusChanges)
    ])
  )
  return workIssues.map(({ number, title, closedWeekStart, delegationCategory }) => {
    const minutesToPullRequest = minutesByIssueNumber.get(number) ?? null
    return {
      title,
      closedWeekStart,
      delegationCategory,
      ...(minutesToPullRequest === null
        ? {}
        : { minutesToPullRequest: roundToOneDecimal(minutesToPullRequest) })
    }
  })
}

/**
 * マージした PR の1件ごとの記録を作る。
 *
 * @param {{ week: { weekStart: string }, pullRequests: MergedPullRequest[] }[]} weeklyTallies 週ごとの集計
 * @returns {{ title: string, mergedWeekStart: string, changedLines: number, isHumanReviewTarget: boolean }[]} マージした週の順の記録
 */
function buildMergedPullRequestRecords(weeklyTallies) {
  return weeklyTallies.flatMap(({ week, pullRequests }) =>
    pullRequests.map((pullRequest) => ({
      title: pullRequest.title,
      mergedWeekStart: week.weekStart,
      changedLines: countChangedLines(pullRequest),
      isHumanReviewTarget: hasAnyLabel(pullRequest, [HUMAN_REVIEW_LABEL])
    }))
  )
}

/**
 * @param {MergedPullRequest} pullRequest マージされた PR
 * @returns {number} 追加と削除の行数の合計
 */
function countChangedLines({ additions, deletions }) {
  return additions + deletions
}

/**
 * @param {StatusChange[]} statusChanges 1件の Issue の Status の変更（古い順）
 * @returns {number | null} 最初の `In Review` の直前の `In progress` から、その `In Review` までの分。どちらかの記録が無ければ null
 */
function measureMinutesToPullRequest(statusChanges) {
  const firstReviewIndex = statusChanges.findIndex(({ status }) => status === IN_REVIEW_STATUS)
  if (firstReviewIndex === -1) return null
  const startedChange = statusChanges
    .slice(0, firstReviewIndex)
    .findLast(({ status }) => status === IN_PROGRESS_STATUS)
  if (!startedChange) return null
  const elapsedMilliseconds =
    new Date(statusChanges[firstReviewIndex].createdAt).getTime() -
    new Date(startedChange.createdAt).getTime()
  return elapsedMilliseconds / MILLISECONDS_PER_MINUTE
}

/**
 * @param {number[]} numbers 1つ以上の数
 * @returns {number} 中央値。個数が偶数なら、真ん中の2つの平均
 */
function findMedian(numbers) {
  const sortedNumbers = numbers.toSorted((left, right) => left - right)
  const middleIndex = Math.floor(sortedNumbers.length / 2)
  if (sortedNumbers.length % 2 === 1) return sortedNumbers[middleIndex]
  return (sortedNumbers[middleIndex - 1] + sortedNumbers[middleIndex]) / 2
}

/**
 * @param {number} rawNumber 丸める数
 * @returns {number} 小数第1位に四捨五入した値
 */
function roundToOneDecimal(rawNumber) {
  return Math.round(rawNumber * 10) / 10
}

/**
 * @param {{ labels: { nodes: { name: string }[] } }} issueOrPullRequest 調べる Issue か PR
 * @param {string[]} labelNames 探すラベルの名前
 * @returns {boolean} どれか1つでも付いていれば true
 */
function hasAnyLabel(issueOrPullRequest, labelNames) {
  return issueOrPullRequest.labels.nodes.some(({ name }) => labelNames.includes(name))
}

/**
 * @returns {string} 今いるリポジトリ（owner/repo）
 * @throws {TechnicalError} gh が失敗したとき
 */
function readCurrentRepository() {
  return runJson('gh', ['repo', 'view', '--json', 'nameWithOwner']).nameWithOwner
}

/**
 * @returns {boolean} app/・infra/ に git の管理下のファイルが1つでもあれば true
 * @throws {TechnicalError} git が失敗したとき
 */
function readHasProductCode() {
  return runOrThrow('git', ['ls-files', 'app', 'infra']).trim() !== ''
}

/**
 * @returns {string} 報告の時間帯での今日（YYYY-MM-DD）
 */
function getTodayInReportTimezone() {
  return formatDate(new Date(Date.now() + REPORT_UTC_OFFSET_MILLISECONDS))
}

/**
 * @param {string} date 基準の日（YYYY-MM-DD）
 * @returns {string} 1か月前の同じ日。その月に同じ日が無ければ月末
 */
function findOneMonthBefore(date) {
  const [year, month, day] = date.split('-').map(Number)
  const lastDayOfPreviousMonth = new Date(Date.UTC(year, month - 1, 0)).getUTCDate()
  return formatDate(new Date(Date.UTC(year, month - 2, Math.min(day, lastDayOfPreviousMonth))))
}

/**
 * @param {string} date 基準の日（YYYY-MM-DD）
 * @returns {string} その日が属する週の月曜日
 */
function findMonday(date) {
  const daysSinceMonday = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % DAYS_PER_WEEK
  return addDays(date, -daysSinceMonday)
}

/**
 * @param {string} date 基準の日（YYYY-MM-DD）
 * @param {number} days 足す日数
 * @returns {string} 足した後の日
 */
function addDays(date, days) {
  return formatDate(new Date(new Date(`${date}T00:00:00Z`).getTime() + days * MILLISECONDS_PER_DAY))
}

/**
 * @param {Date} date 日付
 * @returns {string} UTC の暦日を YYYY-MM-DD で書いたもの。別の時間帯の日付が要るときは、呼び出し側が時差を足した Date を渡す
 */
function formatDate(date) {
  return date.toISOString().slice(0, 10)
}

try {
  runCli()
} catch (error) {
  console.error(error instanceof BusinessError ? error.message : error.stack)
  process.exit(1)
}
