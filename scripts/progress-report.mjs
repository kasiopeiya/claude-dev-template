#!/usr/bin/env node
// 責務: 指定した期間に完了した作業 Issue を、assignee ごとにまとめ、各 Issue の本文と、Issue を閉じた PR のタイトルを添えて、JSON で標準出力に返す。
//   チームの進捗報告で「人ごとにやったこと」を一覧にする材料である。総括の文章は書かない（後続の Skill が、この結果を読んで書く）。
//
// 設計意図（WHY）:
// - 一覧をスクリプトで出す。報告の数字は誰が打っても同じでなければならず、AI に数えさせると、
//   レビュー通知や親 Issue を数えるかが打つたびにぶれて、報告どうしを比べられない（`scripts/perf-report.mjs` と同じ理由）。
// - 作業 Issue の定義は `scripts/lib/work-issues.mjs` の `findExclusionReason` に任せ、ここに写さない。
//   定義が2か所になると、片方だけ直したときに `/perf-report` の `workIssueCount` と食い違う。
// - 人は Issue の assignee で分ける。PR の作成者では分けない。マージした PR がすべて bot 名義のリポジトリがあり、全件が bot の欄に入るためである。
//   assignee は、起票した人（`/quick-issue` などは `--assignee @me` で起票する）と、着手した人（着手時に打つ `npm run move-issue-card` が足す）になる。
//   2人が違う Issue は、両方の欄に載る。
// - 「担当なし」は、GitHub のログイン名に使えない文字（日本語）で書く。実在のログイン名と衝突しない。
// - 対象のリポジトリは、コマンドを打ったリポジトリに固定する。
// - 検索は期間をまとめて1回で打つ。GitHub の検索は1回で 1000 件までしか返さないので、超えたら、欠けたまま返さず失敗にする。
//   1週間ほどの報告を想定し、1000 件を超える長い期間は扱わない。期間を縮めれば解消するので、失敗は利用者が直せる誤り（BusinessError）にする。
// - Issue を閉じた PR は、マージ済みのものだけを載せる。閉じただけでマージしていない PR は、Issue を片付けた記録にならない。
// - タイトル先頭の段番号（`1. `・`1〜3. `）は外す。Issue の並び順を表す印で、何の作業かを表さない。
// - 日付の読み方（`parsePeriod` など）は `scripts/perf-report.mjs` と同じ形で持つ。同ファイルは末尾で `runCli()` を直接実行するので import できない。
// - 日付は固定幅の文字列のまま大小を比べる（`--from` と `--to` の前後）。年を 4 桁に収まる範囲へ絞るのはそのためである。
//
// 使い方: npm run --silent progress-report -- [--from YYYY-MM-DD] [--to YYYY-MM-DD]
//   日付は日本時間で読む。--to の既定は今日、--from の既定は --to の6日前（--to の日を含めて7日）である

import { parseArgs } from 'node:util'

import { runJson } from './auto-programmer/shell.mjs'
import { BusinessError } from './lib/errors.mjs'
import { EXCLUSION_TARGET_FIELDS, findExclusionReason } from './lib/work-issues.mjs'

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000
const DEFAULT_PERIOD_DAYS = 7
const SEARCH_RESULT_LIMIT = 1000
const MIN_SUPPORTED_YEAR = 1000
const MAX_SUPPORTED_YEAR = 9998

const REPORT_UTC_OFFSET = '+09:00'
const REPORT_UTC_OFFSET_MILLISECONDS = 9 * 60 * 60 * 1000

const UNASSIGNED_SECTION_NAME = '担当なし'
const SEQUENCE_NUMBER_PREFIX_PATTERN = /^\d+(〜\d+)?\.\s+/

// assignees は GitHub の上限（10人）に収まる。closedByPullRequestsReferences は、20件を超えると例外を出さず後ろが欠けるが、
// 1つの Issue を閉じる PR が20件を超える使い方は扱わない
const CLOSED_ISSUES_QUERY = `query($searchQuery: String!, $endCursor: String) {
  search(query: $searchQuery, type: ISSUE, first: 100, after: $endCursor) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on Issue {
        number
        title
        body
        assignees(first: 20) { nodes { login } }
        closedByPullRequestsReferences(first: 20) { nodes { title merged } }
        ${EXCLUSION_TARGET_FIELDS}
      }
    }
  }
}`

/**
 * `CLOSED_ISSUES_QUERY` で引いた Issue。作業 Issue の判定に使う項目（`ExclusionTarget`）も含む。
 *
 * @typedef {object} ClosedIssue
 * @property {number} number Issue 番号
 * @property {string} title タイトル
 * @property {string} body 本文
 * @property {{ nodes: { login: string }[] }} assignees assignee
 * @property {{ nodes: { title: string, merged: boolean }[] }} closedByPullRequestsReferences Issue を閉じた PR
 */

/**
 * @typedef {object} WorkIssue
 * @property {number} number Issue 番号
 * @property {string} title 先頭の段番号を外したタイトル
 * @property {string} body 本文
 * @property {string[]} closingPullRequestTitles Issue を閉じた、マージ済みの PR のタイトル
 */

/**
 * @typedef {object} AssigneeSection
 * @property {string} assignee ログイン名。assignee の無い Issue の欄は「担当なし」
 * @property {WorkIssue[]} workIssues その人の欄に載る作業 Issue（番号の昇順）
 */

/**
 * CLI として実行したときの本体。assignee ごとの作業 Issue を JSON で標準出力に返す。
 *
 * @returns {void}
 * @throws {BusinessError} 期間の引数が不正なとき・検索の上限を超えて数え切れないとき
 * @throws {TechnicalError} gh が失敗したとき
 */
function runCli() {
  const today = getTodayInReportTimezone()
  const { from, to } = parsePeriod(process.argv.slice(2), today)
  const repository = readCurrentRepository()
  const closedWorkIssues = fetchClosedIssues({ repository, from, to }).filter(
    (closedIssue) => findExclusionReason(closedIssue) === null
  )
  const report = {
    repository,
    from,
    to,
    workIssueCount: closedWorkIssues.length,
    assigneeSections: groupByAssignee(closedWorkIssues)
  }
  console.log(JSON.stringify(report, null, 2))
}

/**
 * 作業 Issue を assignee ごとの欄に分ける。assignee が複数なら全員の欄に載せ、0人なら「担当なし」の欄に載せる。
 *
 * @param {ClosedIssue[]} closedWorkIssues 作業 Issue
 * @returns {AssigneeSection[]} ログイン名の昇順に並べた欄。「担当なし」は、あれば最後に置く
 */
function groupByAssignee(closedWorkIssues) {
  const workIssuesByAssignee = new Map()
  for (const closedIssue of closedWorkIssues) {
    for (const assignee of listAssignees(closedIssue)) {
      const workIssues = workIssuesByAssignee.get(assignee) ?? []
      workIssues.push(toWorkIssue(closedIssue))
      workIssuesByAssignee.set(assignee, workIssues)
    }
  }
  return [...workIssuesByAssignee]
    .map(([assignee, workIssues]) => ({
      assignee,
      workIssues: workIssues.toSorted((left, right) => left.number - right.number)
    }))
    .toSorted(compareAssigneeSections)
}

/**
 * @param {ClosedIssue} closedIssue Issue
 * @returns {string[]} assignee のログイン名。0人なら「担当なし」だけを返す
 */
function listAssignees(closedIssue) {
  const logins = closedIssue.assignees.nodes.map(({ login }) => login)
  return logins.length === 0 ? [UNASSIGNED_SECTION_NAME] : logins
}

/**
 * @param {ClosedIssue} closedIssue Issue
 * @returns {WorkIssue} 報告に載せる形
 */
function toWorkIssue(closedIssue) {
  return {
    number: closedIssue.number,
    title: closedIssue.title.replace(SEQUENCE_NUMBER_PREFIX_PATTERN, ''),
    body: closedIssue.body,
    closingPullRequestTitles: closedIssue.closedByPullRequestsReferences.nodes
      .filter(({ merged }) => merged)
      .map(({ title }) => title)
  }
}

/**
 * @param {AssigneeSection} left 比べる欄
 * @param {AssigneeSection} right 比べる欄
 * @returns {number} ログイン名の昇順にする並び替えの比較結果。「担当なし」は最後にする
 */
function compareAssigneeSections(left, right) {
  const isLeftUnassigned = left.assignee === UNASSIGNED_SECTION_NAME
  const isRightUnassigned = right.assignee === UNASSIGNED_SECTION_NAME
  if (isLeftUnassigned !== isRightUnassigned) return isLeftUnassigned ? 1 : -1
  // GitHub のログイン名は大文字小文字を区別しないので、小文字にそろえて比べる
  const leftLogin = left.assignee.toLowerCase()
  const rightLogin = right.assignee.toLowerCase()
  if (leftLogin === rightLogin) return 0
  return leftLogin < rightLogin ? -1 : 1
}

/**
 * 日本時間の範囲に close された Issue を、最後のページまで引く。
 *
 * @param {{ repository: string, from: string, to: string }} searchRange 対象のリポジトリ（owner/repo）と、範囲の初日・最終日（YYYY-MM-DD）
 * @returns {ClosedIssue[]} close された Issue
 * @throws {BusinessError} 検索の上限を超えて数え切れないとき
 * @throws {TechnicalError} gh が失敗したとき
 */
function fetchClosedIssues({ repository, from, to }) {
  const pages = runJson('gh', [
    'api',
    'graphql',
    '--paginate',
    '--slurp',
    '-f',
    `query=${CLOSED_ISSUES_QUERY}`,
    '-f',
    `searchQuery=repo:${repository} is:issue is:closed closed:${formatSearchRange(from, to)}`
  ])
  const { issueCount } = pages[0].data.search
  if (issueCount > SEARCH_RESULT_LIMIT) {
    throw new BusinessError(
      `${from}〜${to} は ${issueCount} 件あり、検索の上限（${SEARCH_RESULT_LIMIT} 件）を超えるので数え切れません。期間を縮めてください`
    )
  }
  return pages.flatMap((page) => page.data.search.nodes)
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
  const from = values.from ?? addDays(to, 1 - DEFAULT_PERIOD_DAYS)
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
 * @param {string} from 範囲の初日（YYYY-MM-DD）
 * @param {string} to 範囲の最終日（YYYY-MM-DD）
 * @returns {string} GitHub の検索に渡す、日本時間の日時の範囲
 */
function formatSearchRange(from, to) {
  return `${from}T00:00:00${REPORT_UTC_OFFSET}..${to}T23:59:59${REPORT_UTC_OFFSET}`
}

/**
 * @returns {string} 今いるリポジトリ（owner/repo）
 * @throws {TechnicalError} gh が失敗したとき
 */
function readCurrentRepository() {
  return runJson('gh', ['repo', 'view', '--json', 'nameWithOwner']).nameWithOwner
}

/**
 * @returns {string} 報告の時間帯での今日（YYYY-MM-DD）
 */
function getTodayInReportTimezone() {
  return formatDate(new Date(Date.now() + REPORT_UTC_OFFSET_MILLISECONDS))
}

/**
 * @param {string} date 基準の日（YYYY-MM-DD）
 * @param {number} days 足す日数（引くときは負）
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
