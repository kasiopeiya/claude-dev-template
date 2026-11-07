#!/usr/bin/env node
// 責務: 指定した期間に完了した作業 Issue を、日本時間の月曜始まりの週ごとと委譲の分類ごとに数え、JSON で標準出力に返す。
//   `/perf-report` が、この結果を HTML 1枚にする。
//
// 設計意図（WHY）:
// - 数える処理をスクリプトに置く。報告の数字は誰が打っても同じでなければならず、AI に数えさせると打つたびにぶれる。
// - 検索は週ごとに分けて打つ。GitHub の検索は1回で 1000 件までしか返さないので、期間をまとめて打つと、長い期間で黙って欠ける。
//   それでも 1000 件を超える週は、欠けたまま数えず失敗にする。
// - 親かどうかは subIssues の有無で決める。`tracking-issue` は第2階層の親にしか付かない（#1587）。
// - レビュー通知は bot 名義に限る。`needs-human-review` は PR のラベルで、作業でないのは bot が起票する通知の Issue だけである。
// - ラベルも本文も無い Issue はメモとして除く。#835 の子に資料の見出しだけを書いたものがあり（#939 など）、何の作業かを確かめられない。
// - 委譲の分類はラベルだけで決める。他のリポジトリでも同じ Skill が使えるようにするためである（#1591）。
//   無人実行の記録（runs.jsonl）は使わない。無人実行の定義に問題があり、端末ごとの記録でもある。
// - hasProductCode も返す。`/perf-report` は、app/・infra/ にコードが無いときだけ「本番では未検証」と注記する。
// - 日付は固定幅の文字列のまま大小を比べる。年を 4 桁に収まる範囲へ絞るのはそのためで、外れると週を進めるループが終わらない。
//
// 使い方: npm run --silent perf-report -- [--from YYYY-MM-DD] [--to YYYY-MM-DD]
//   日付は日本時間で読む。--to の既定は今日、--from の既定は --to の1か月前である

import { parseArgs } from 'node:util'

import { runJson, runOrThrow } from './auto-programmer/shell.mjs'
import { BusinessError, TechnicalError } from './lib/errors.mjs'

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000
const DAYS_PER_WEEK = 7
const SEARCH_RESULT_LIMIT = 1000
const MIN_SUPPORTED_YEAR = 1000
const MAX_SUPPORTED_YEAR = 9998

const REPORT_TIMEZONE_NAME = 'Asia/Tokyo'
const REPORT_UTC_OFFSET = '+09:00'
const REPORT_UTC_OFFSET_MILLISECONDS = 9 * 60 * 60 * 1000

const REVIEW_NOTIFICATION_LABEL = 'needs-human-review'
const ROOT_ISSUE_LABEL = 'phase'
const WEEKLY_ISSUE_LABELS = ['doc-audit-weekly', 'code-policy-weekly']
const AI_FIXABLE_LABEL = 'ai-fixable'
const READY_FOR_HUMAN_LABEL = 'ready-for-human'
const COLLABORATION_LABEL = 'human-ai-collaboration'

const CLOSED_ISSUES_QUERY = `query($searchQuery: String!, $endCursor: String) {
  search(query: $searchQuery, type: ISSUE, first: 100, after: $endCursor) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on Issue {
        stateReason
        body
        author { __typename }
        labels(first: 50) { nodes { name } }
        subIssues { totalCount }
      }
    }
  }
}`

/**
 * @typedef {object} ClosedIssue
 * @property {string | null} stateReason close の理由（COMPLETED・NOT_PLANNED・DUPLICATE）
 * @property {string} body 本文
 * @property {{ __typename: string } | null} author 起票者（アカウントが消えていれば null）
 * @property {{ nodes: { name: string }[] }} labels ラベル
 * @property {{ totalCount: number }} subIssues 子 Issue
 */

// 上から順に当て、最初に当たった理由だけで数える。理由ごとの件数を足すと、除外した総数に一致する
const EXCLUSION_RULES = [
  { reason: 'notCompleted', matches: (issue) => issue.stateReason !== 'COMPLETED' },
  {
    reason: 'reviewNotification',
    matches: (issue) =>
      issue.author?.__typename === 'Bot' && hasAnyLabel(issue, [REVIEW_NOTIFICATION_LABEL])
  },
  { reason: 'parent', matches: (issue) => issue.subIssues.totalCount > 0 },
  { reason: 'rootIssue', matches: (issue) => hasAnyLabel(issue, [ROOT_ISSUE_LABEL]) },
  { reason: 'weeklyIssue', matches: (issue) => hasAnyLabel(issue, WEEKLY_ISSUE_LABELS) },
  {
    reason: 'memo',
    matches: (issue) => issue.labels.nodes.length === 0 && issue.body.trim() === ''
  }
]

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
  const weeklyTallies = splitIntoWeeks({ from, to }).map((week) => ({
    week,
    tally: tallyIssues(
      fetchClosedIssues({ repository, from: week.countedFrom, to: week.countedTo })
    )
  }))
  const report = buildReport({ repository, from, to, today, weeklyTallies })
  console.log(JSON.stringify(report, null, 2))
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
  const closedRange = `${from}T00:00:00${REPORT_UTC_OFFSET}..${to}T23:59:59${REPORT_UTC_OFFSET}`
  const searchQuery = `repo:${repository} is:issue is:closed closed:${closedRange}`
  const pages = runJson('gh', [
    'api',
    'graphql',
    '--paginate',
    '--slurp',
    '-f',
    `query=${CLOSED_ISSUES_QUERY}`,
    '-f',
    `searchQuery=${searchQuery}`
  ])
  const { issueCount } = pages[0].data.search
  if (issueCount > SEARCH_RESULT_LIMIT) {
    throw new TechnicalError(
      `${from}〜${to} は ${issueCount} 件あり、検索の上限（${SEARCH_RESULT_LIMIT} 件）を超えるので数え切れません`
    )
  }
  return pages.flatMap((page) => page.data.search.nodes)
}

/**
 * Issue を、作業 Issue・除外の理由ごと・委譲の分類ごとに数える。
 *
 * @param {ClosedIssue[]} issues close された Issue
 * @returns {{ workIssueCount: number, excludedCounts: Record<string, number>, delegationCounts: Record<string, number> }} 作業 Issue の件数と、除外の理由ごと・委譲の分類ごとの件数
 */
function tallyIssues(issues) {
  const excludedCounts = createEmptyExcludedCounts()
  const delegationCounts = createEmptyDelegationCounts()
  let workIssueCount = 0
  for (const issue of issues) {
    const matchedRule = EXCLUSION_RULES.find(({ matches }) => matches(issue))
    if (matchedRule) {
      excludedCounts[matchedRule.reason] += 1
    } else {
      workIssueCount += 1
      delegationCounts[findDelegationCategory(issue)] += 1
    }
  }
  return { workIssueCount, excludedCounts, delegationCounts }
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
 * @param {{ repository: string, from: string, to: string, today: string, weeklyTallies: { week: { weekStart: string, weekEnd: string, countedFrom: string, countedTo: string }, tally: ReturnType<typeof tallyIssues> }[] }} reportSource 集計の結果と、その条件
 * @returns {object} 標準出力に出す内容
 * @throws {TechnicalError} git が失敗したとき
 */
function buildReport({ repository, from, to, today, weeklyTallies }) {
  const weeks = weeklyTallies.map(({ week, tally }) => ({
    ...week,
    workIssueCount: tally.workIssueCount,
    isFullWeek: isFullWeek(week, today)
  }))
  const workIssueCount = weeks.reduce((sum, week) => sum + week.workIssueCount, 0)
  const excludedCounts = sumExcludedCounts(weeklyTallies.map(({ tally }) => tally))
  const excludedIssueCount = Object.values(excludedCounts).reduce((sum, count) => sum + count, 0)
  return {
    repository,
    period: { from, to, timezone: REPORT_TIMEZONE_NAME },
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
  return Object.fromEntries(EXCLUSION_RULES.map(({ reason }) => [reason, 0]))
}

/**
 * @param {{ excludedCounts: Record<string, number> }[]} tallies 週ごとの集計
 * @returns {Record<string, number>} 除外の理由ごとの、全週の合計
 */
function sumExcludedCounts(tallies) {
  const totalCounts = createEmptyExcludedCounts()
  for (const { excludedCounts } of tallies) {
    for (const { reason } of EXCLUSION_RULES) totalCounts[reason] += excludedCounts[reason]
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
    average: Math.round((totalCount / fullWeekIssueCounts.length) * 10) / 10,
    min: Math.min(...fullWeekIssueCounts),
    max: Math.max(...fullWeekIssueCounts)
  }
}

/**
 * @param {ClosedIssue} issue 調べる Issue
 * @param {string[]} labelNames 探すラベルの名前
 * @returns {boolean} どれか1つでも付いていれば true
 */
function hasAnyLabel(issue, labelNames) {
  return issue.labels.nodes.some(({ name }) => labelNames.includes(name))
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
