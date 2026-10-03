#!/usr/bin/env node
// 責務: ボードの着手待ちのカードから Issue を1件ずつ拾い、AI 専用 clone で実装させ、CI の通った PR まで到達させる唯一の入口。
//
// 設計意図（WHY）:
// - 拾う・順序を決める・記録するはすべてここで決定論的に行う。AI に任せると、同じ盤面から毎回
//   違う Issue を拾い、何が起きたかを追えなくなる。AI に渡すのは Issue 1件の監査・実装・CI の修正だけ。
// - 着手できる Issue が無くても、すぐには終了せず、待って見に行く。自分から終了すると、人間が
//   Issue の数だけ打ち直すことになる（Issue #481）。ただし着手できない周が続いて maxConsecutiveIdleWaits 回
//   待っても、次の周でまだ着手できなければ止まる。放置したまま見に行き続けると、gh の呼び出しが積み上がって GitHub API の
//   レート制限に触れ、ほかの gh 操作まで失敗するからである（Issue #834）。例外がもう1つあり、
//   claude のセッションが続けて失敗したときも止める。続けるほどカードを空振りで着手中へ送るためである。
// - 着手前に落ちた Issue は飛ばして次の候補へ進む。カードは着手待ちに残るので、原因を直せば
//   次の巡回で拾われる。飛ばさずに止まると、先頭の1件が詰まっただけで後ろの全件が止まる。
// - 落ちうるローカルの準備（clone の巻き戻し・依存）をすべて済ませてから、カードを「着手中」へ動かす。
//   動かした後は着手待ちへ戻さないので、次の巡回が同じ Issue をもう一度拾うことはない。
// - 着手中へ動かした後は、何が起きても記録を1行残す。無人で走るので、記録が唯一の痕跡になる。
// - 実装の前に `/issue-check` を別プロセスで通し、書き戻されたラベルと state だけで進むか止めるかを
//   決める（Issue #482）。止めた Issue のカードは着手中のまま残し、人間が見るまで次の巡回で拾わない。
//   監査は `issue:checked` が無い Issue にだけ走らせ、貼られたことを「今回の判定が書き戻された」印にする。
// - `issue:checked` が付いた Issue は監査し直さない。人間がローカルでまとめて監査してから Ready へ積む
//   運用が多く、毎回の再監査は同じ判定を繰り返すだけになる。監査後に前提が崩れていれば `/auto-dev` が離脱する。
// - open な sub-issue を持つ Issue は実装せず、子を着手待ちに載せて拾わせる（どの子を載せるかは subIssueHandover.mjs）。
//   確かめるのは `/issue-check` の前と後で、前は割り済みの親に監査の費用を掛けないため、後は今回の監査が割った分を
//   拾うため。親のカードは着手中のまま残す。子が進んでいる間、親は作業中である。
// - PR を作った後は、CI の結果が出るまで次の Issue へ進まない。落ちていれば `/auto-fix-ci` を
//   別プロセスで起こして直させ、上限まで直させても落ちていれば人間へ回す。待たずに次へ進むと、落ちた PR が
//   誰にも直されずに残る。CI が落ちたこと自体はセッションの失敗に数えない（claude が壊れている兆候ではない）。
// - CI が通ったときだけカードを「レビュー待ち」へ動かす。人間がレビュー待ちの列だけを見ればよい状態を保つ。
//   動かせなくても例外にせず記録に残す。PR はできているので、ボードの不調で次の Issue を止める理由が無い。
// - 毎周、Issue を選ぶ前に、自動マージされた PR が閉じ損ねた Issue を閉じる（Issue #744）。起動時の1回だけだと、
//   回っている間にマージされた PR の Issue が閉じず、それを「ブロッカー」に持つ Issue がいつまでも拾われない。
//   閉じられなくても次の Issue は選べるので、失敗しても周回は止めない。

import { setImmediate as yieldToEventLoop, setTimeout as sleep } from 'node:timers/promises'

import { closeIssuesOfMergedPullRequests } from '../close-issues.mjs'
import {
  listStartableIssues,
  markAsInReview,
  markAsStarted,
  putOnReadyAssignedToMe
} from './board.mjs'
import { buildBranchName } from './branchName.mjs'
import { runAutoDevSession, runAutoFixCiSession, runIssueCheckSession } from './claudeSession.mjs'
import { config } from './config.mjs'
import { decideAfterIdlePoll, validateMaxConsecutiveIdleWaits } from './idleWait.mjs'
import {
  findReasonToSkipImplementation,
  ISSUE_CHECKED_LABEL,
  NEEDS_HUMAN_DECISION_LABEL
} from './issueCheckVerdict.mjs'
import { decideAfterCiRun, readCiRunState } from './ciRun.mjs'
import { ensureDependencies, runPreflight } from './preflight.mjs'
import { recordRun } from './runLog.mjs'
import { runJson, runOrThrow } from './shell.mjs'
import { startSleepGuard } from './sleepGuard.mjs'
import {
  findReasonToSkipForOpenSubIssues,
  selectSubIssuesToPutOnReady
} from './subIssueHandover.mjs'
import {
  createThrottledStatusLine,
  showError,
  showInfo,
  showIssueBanner,
  showStatusLine,
  showSuccess,
  showWarning
} from './ui.mjs'
import { collapseToSingleLine, formatElapsedTime } from './uiFormat.mjs'
import { prepareTopicBranch } from './workspace.mjs'

const MILLISECONDS_PER_SECOND = 1000
const MILLISECONDS_PER_MINUTE = 60 * MILLISECONDS_PER_SECOND

// 候補が無かったときに、ボードを見直すまで待つ時間
const POLL_INTERVAL_MS = config.pollIntervalMinutes * MILLISECONDS_PER_MINUTE

const CI_POLL_INTERVAL_MS = config.ci.pollIntervalSeconds * MILLISECONDS_PER_SECOND
const CI_RUN_WAIT_LIMIT_MS = config.ci.runWaitLimitMinutes * MILLISECONDS_PER_MINUTE

// 非TTY で CI 待ちの経過を追記する間隔。CI_POLL_INTERVAL_MS のまま追記すると、
// 上限（runWaitLimitMinutes）いっぱい待つ実行で数十行に膨らむ
const CI_WAIT_PROGRESS_APPEND_INTERVAL_MS = 5 * MILLISECONDS_PER_MINUTE

// /auto-dev・/auto-fix-ci が離脱するときに貼るラベル。両 Skill の SKILL.md（離脱手順）の表記と一字一句合わせる
const NEEDS_CLEAN_SESSION_LABEL = 'issue:needs-clean-session'

// GraphQL が1つの接続（sub-issue・ラベル・カード）から一度に返せる件数の上限。sub-issue は超えていたら読み落としとして止める
const GRAPHQL_CONNECTION_FETCH_LIMIT = 100

// 1つの Issue に付けられる担当者の上限（GitHub の仕様）。この件数を読めば全員がそろう
const ISSUE_ASSIGNEE_LIMIT = 10

// gh issue view の --json は sub-issue を返さないので、GraphQL で引く。自分のログイン名（viewer）も同じ呼び出しで引く
const SUB_ISSUES_QUERY = `query($owner: String!, $name: String!, $number: Int!, $statusFieldName: String!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      subIssues(first: ${GRAPHQL_CONNECTION_FETCH_LIMIT}) {
        totalCount
        nodes {
          number
          url
          state
          repository { nameWithOwner }
          assignees(first: ${ISSUE_ASSIGNEE_LIMIT}) { nodes { login } }
          labels(first: ${GRAPHQL_CONNECTION_FETCH_LIMIT}) { nodes { name } }
          projectItems(first: ${GRAPHQL_CONNECTION_FETCH_LIMIT}) {
            nodes {
              project { number owner { ... on User { login } ... on Organization { login } } }
              fieldValueByName(name: $statusFieldName) { ... on ProjectV2ItemFieldSingleSelectValue { name } }
            }
          }
        }
      }
    }
  }
}`

// セッションがこの回数続けて失敗したら止める。claude 側が壊れている（ログイン切れ・利用上限など）と、
// 待たずに次のカードを着手中へ送り、Ready のカードを PR 無しのまま使い切るため
const MAX_CONSECUTIVE_SESSION_FAILURES = 2

// Ctrl+C を「実行中の1件を記録してから止める」にする。リスナが無いと node はその場で終了し、記録が残らない。
// reason には受けたシグナルを入れる。claude セッションは別のプロセスグループで動くので、端末のシグナルは
// 届かず、この中止を通して同じシグナルを子孫ごと送る（shell.mjs の runStreamingAsync）
const stopController = new AbortController()
process.on('SIGINT', () => stopController.abort('SIGINT'))
// 端末の切断（SIGHUP）・SIGTERM・Ctrl+\（SIGQUIT）は、claude セッションへ送ってから、既定どおりこのプロセスも終わる。
// once にするのは、送り直した同じシグナルでリスナが再び呼ばれず、既定の終了に至るようにするため
for (const signal of ['SIGHUP', 'SIGTERM', 'SIGQUIT']) {
  process.once(signal, () => {
    stopController.abort(signal)
    process.kill(process.pid, signal)
  })
}

/**
 * 例外を表示用の文字列にする。
 *
 * @param {unknown} error 受け取った例外
 * @param {{ withStack?: boolean }} [options] 予期しない例外として stack まで出すか
 * @returns {string} 表示する文字列
 */
function formatError(error, { withStack = false } = {}) {
  if (!(error instanceof Error)) return String(error)
  return withStack ? (error.stack ?? error.message) : error.message
}

/**
 * ブランチに紐づく PR を、閉じたものも含めて一覧で引く。
 *
 * @param {string} branchName トピックブランチ名
 * @returns {{ number: number, url: string }[]} PR の番号と URL
 * @throws {Error} gh が失敗したとき
 */
function listPullRequests(branchName) {
  return runJson('gh', [
    'pr',
    'list',
    '--repo',
    config.repository,
    '--head',
    branchName,
    '--state',
    'all',
    '--json',
    'number,url'
  ])
}

/**
 * Issue の state とラベルを引き直す。
 *
 * @param {number} issueNumber Issue の番号
 * @returns {{ state: string, labelNames: string[] }} state（'OPEN' / 'CLOSED'）とラベル名
 * @throws {Error} gh が失敗したとき
 */
function readIssueStatus(issueNumber) {
  const { state, labels } = runJson('gh', [
    'issue',
    'view',
    String(issueNumber),
    '--repo',
    config.repository,
    '--json',
    'state,labels'
  ])
  return { state, labelNames: labels.map(({ name }) => name) }
}

/**
 * GraphQL が返した sub-issue のノードを、子を選ぶ純粋関数が受け取る形にする。
 *
 * @param {{ number: number, url: string, state: string, repository: { nameWithOwner: string }, assignees: { nodes: { login: string }[] }, labels: { nodes: { name: string }[] }, projectItems: { nodes: { project?: { number: number, owner: { login?: string } }, fieldValueByName?: { name?: string } | null }[] } }} node sub-issue のノード
 * @returns {{ number: number, url: string, state: string, repository: string, labelNames: string[], assigneeLogins: string[], boardStatusName: string | null }} 子（boardStatusName は config.mjs のボードに無ければ null）
 */
function toSubIssue({ number, url, state, repository, assignees, labels, projectItems }) {
  const boardItem = projectItems.nodes.find(
    ({ project }) =>
      project?.number === config.board.number && project.owner.login === config.board.owner
  )
  return {
    number,
    url,
    state,
    repository: repository.nameWithOwner,
    labelNames: labels.nodes.map((label) => label.name),
    assigneeLogins: assignees.nodes.map((assignee) => assignee.login),
    boardStatusName: boardItem?.fieldValueByName?.name ?? null
  }
}

/**
 * Issue の sub-issue と、gh にログインしている自分のログイン名を引く。
 *
 * @param {number} issueNumber 親 Issue の番号
 * @returns {{ viewerLogin: string, subIssues: ReturnType<typeof toSubIssue>[] }} 自分のログイン名と sub-issue（state は 'OPEN' / 'CLOSED'）
 * @throws {Error} gh が失敗したとき・sub-issue が一度に読める件数を超えたとき
 */
function listSubIssues(issueNumber) {
  const [repositoryOwner, repositoryName] = config.repository.split('/')
  const { data } = runJson('gh', [
    'api',
    'graphql',
    '-f',
    `query=${SUB_ISSUES_QUERY}`,
    '-f',
    `owner=${repositoryOwner}`,
    '-f',
    `name=${repositoryName}`,
    '-F',
    `number=${issueNumber}`,
    '-f',
    `statusFieldName=${config.board.statusFieldName}`
  ])
  const { totalCount, nodes } = data.repository.issue.subIssues
  if (totalCount > nodes.length) {
    throw new Error(
      `#${issueNumber} の sub-issue ${totalCount} 件のうち ${nodes.length} 件しか読めていません。読み落とした子を載せ損ねるため止めます`
    )
  }
  return { viewerLogin: data.viewer.login, subIssues: nodes.map(toSubIssue) }
}

/**
 * open な sub-issue を持つ Issue なら、子のうち載せてよいものを着手待ちに載せ、担当者を自分にする。結果を record.subIssueHandover へ書く。
 *
 * @param {number} issueNumber 対象 Issue の番号
 * @param {Record<string, unknown>} record 書き足す先の記録
 * @returns {void} open な sub-issue が無ければ record に何も書かない
 * @throws {Error} gh が失敗したとき・sub-issue が一度に読める件数を超えたとき・ボードの表記が config.mjs と食い違うとき
 */
function handOverToSubIssuesIfAny(issueNumber, record) {
  const { viewerLogin, subIssues } = listSubIssues(issueNumber)
  const reason = findReasonToSkipForOpenSubIssues(subIssues)
  if (!reason) return

  const subIssueHandover = { reason, putOnReadySubIssueNumbers: [] }
  record.subIssueHandover = subIssueHandover
  const subIssuesToPutOnReady = selectSubIssuesToPutOnReady(subIssues, {
    repository: config.repository,
    viewerLogin,
    targetIssueLabel: config.targetIssueLabel,
    needsHumanDecisionLabel: NEEDS_HUMAN_DECISION_LABEL,
    notStartedStatusNames: [config.board.todoStatusName, config.board.readyStatusName]
  })
  for (const subIssue of subIssuesToPutOnReady) {
    putOnReadyAssignedToMe(subIssue.url)
    subIssueHandover.putOnReadySubIssueNumbers.push(subIssue.number)
    showInfo(
      `子 #${subIssue.number} を ${config.board.readyStatusName} に載せ、担当者を自分にしました`
    )
  }
}

/**
 * 子へ引き継ごうとして、1件も着手待ちに載せられなかったか。
 *
 * 親は着手中に残るので、子も進んでいなければ、人間が見るまで誰も進めない。
 *
 * @param {{ subIssueHandover?: { putOnReadySubIssueNumbers: number[] } }} record 記録した内容
 * @returns {boolean} 子へ引き継いだうえで、載せた子が0件なら true
 */
function isSubIssueHandoverEmpty(record) {
  return record.subIssueHandover?.putOnReadySubIssueNumbers.length === 0
}

/**
 * claude プロセスが正常終了したか。
 *
 * @param {{ exitCode: number, signal: string | null }} status 終了状態
 * @returns {boolean} 終了コード 0 で、シグナルで止められていなければ true
 */
function hasSessionSucceeded({ exitCode, signal }) {
  return exitCode === 0 && signal === null
}

/**
 * セッションの後に、そのセッションが作った PR の URL を引く。
 *
 * 同じブランチ名で過去に作られた PR と見分けるため、セッション前に無かった番号だけを採る。
 * PR の有無を確かめられなかったときは、「作られなかった」と取り違えないよう null を返す。
 *
 * @param {string} branchName トピックブランチ名
 * @param {Set<number>} existingPullRequestNumbers セッション前からあった PR の番号
 * @returns {string | null} 作られた PR の URL（作られていなければ空文字、確かめられなければ null）
 */
function findCreatedPullRequestUrl(branchName, existingPullRequestNumbers) {
  try {
    const created = listPullRequests(branchName).filter(
      ({ number }) => !existingPullRequestNumbers.has(number)
    )
    return created.length > 0 ? created[created.length - 1].url : ''
  } catch (error) {
    showWarning(`PR の有無を確かめられませんでした: ${formatError(error)}`)
    return null
  }
}

/**
 * Issue 1件の締めとして、所要時間・CI の結果・PR・記録先をまとめて表示する。
 *
 * 締めの記号は、例外の有無だけでなく「人間の手当てが要るか」で決める。実装が失敗しても例外は出ない
 * （セッションが 0 以外で終わるだけ）ので、例外だけで決めると失敗した実行に ✓ が出て、異常が埋もれる。
 *
 * @param {{ issueNumber: number, sessionStartedAt: string, finishedAt: string, pullRequestUrl: string | null, ciOutcome?: string, isCiPassed?: boolean, skippedReason?: string | null, subIssueHandover?: { reason: string, putOnReadySubIssueNumbers: number[] }, error?: string }} record 記録した内容
 * @param {boolean} isAllSessionsSucceeded 走らせた claude セッションがすべて正常終了したか
 * @returns {void}
 */
function showRunSummary(record, isAllSessionsSucceeded) {
  const elapsedTime = formatElapsedTime(
    Date.parse(record.finishedAt) - Date.parse(record.sessionStartedAt)
  )
  const headline = `#${record.issueNumber} を終えました（${elapsedTime}）`
  const needsHumanAttention =
    Boolean(record.skippedReason) ||
    isSubIssueHandoverEmpty(record) ||
    !isAllSessionsSucceeded ||
    record.isCiPassed === false
  if (record.error) showError(headline)
  else if (needsHumanAttention) showWarning(headline)
  else showSuccess(headline)

  if (record.ciOutcome) {
    const showCiOutcome = record.isCiPassed ? showInfo : showWarning
    showCiOutcome(`CI: ${record.ciOutcome}`)
  }
  if (record.pullRequestUrl === null) showWarning('PR の有無は GitHub で確かめてください')
  else showInfo(record.pullRequestUrl ? `PR: ${record.pullRequestUrl}` : 'PR は作られませんでした')
  showInfo(`記録: ${config.runLogPath}`)
}

/**
 * 落ちうるローカルの準備をすべて済ませてから、カードを着手中へ動かす。
 *
 * @param {{ itemId: string, number: number, labelNames: string[] }} issue 対象 Issue
 * @returns {{ branchName: string, existingPullRequestNumbers: Set<number> }} 作ったトピックブランチ名と、着手前からあった PR の番号
 * @throws {Error} 着手中へ動かすまでの処理が落ちたとき（カードは着手待ちのまま残る）
 */
function startIssue(issue) {
  const branchName = buildBranchName({ issueNumber: issue.number, labelNames: issue.labelNames })
  showInfo(`ブランチ: ${branchName}`)

  prepareTopicBranch(branchName)
  ensureDependencies()
  const existingPullRequestNumbers = new Set(
    listPullRequests(branchName).map(({ number }) => number)
  )
  markAsStarted(issue.itemId)
  return { branchName, existingPullRequestNumbers }
}

/**
 * 着手できる Issue を着手順に試し、最初に着手中へ動かせた1件を返す。
 *
 * 着手前に落ちた Issue は理由を出して飛ばす。着手できる Issue が無いときは何も出さない
 * （呼び出し側がアイドル中のステータス行にまとめて示す）。
 *
 * @returns {Promise<{ issue: { itemId: string, number: number, title: string }, branchName: string, existingPullRequestNumbers: Set<number> } | null>} 着手した Issue（着手できる Issue が無い・全部飛ばした・止められたときは null）
 * @throws {Error} 候補を引けなかったとき
 */
async function startFirstStartableIssue() {
  const issues = listStartableIssues()
  if (issues.length === 0) return null

  for (const issue of issues) {
    // 同期処理の合間にイベントループを回し、Ctrl+C を受け取る
    await yieldToEventLoop()
    if (stopController.signal.aborted) return null

    showIssueBanner({ issueNumber: issue.number, title: issue.title })
    try {
      return { issue, ...startIssue(issue) }
    } catch (error) {
      showWarning(`#${issue.number} を飛ばします: ${formatError(error)}`)
    }
  }
  showWarning(`着手できる Issue ${issues.length} 件をすべて飛ばしました`)
  return null
}

/**
 * open な sub-issue を持つなら子を着手待ちに載せて終える。そうでなければ `issue:checked` が無いときだけ `/issue-check` を通し、
 * 監査が割っていれば子を着手待ちに載せ、止める理由も子も無ければ `/auto-dev` を走らせる。結果は record へ書き足す。
 *
 * record を引数で受けるのは、途中で例外が出ても、そこまでの結果を呼び出し側が記録できるようにするため。
 *
 * @param {number} issueNumber 対象 Issue の番号
 * @param {Record<string, unknown>} record 書き足す先の記録
 * @returns {Promise<boolean>} 走らせた claude セッションがすべて正常終了したら true
 * @throws {Error} claude を起動できなかったとき・Issue のラベルを外せなかった／引き直せなかったとき・sub-issue を引けなかった／子を着手待ちに載せられなかったとき
 */
async function handOverOrImplement(issueNumber, record) {
  handOverToSubIssuesIfAny(issueNumber, record)
  // 監査前の親のラベルは止める理由の判定に通さない。`/to-issues` のまとめ用の親は issue:checked を持たないことがある
  if (record.subIssueHandover) return true

  record.issueCheckSkipped = readIssueStatus(issueNumber).labelNames.includes(ISSUE_CHECKED_LABEL)
  if (record.issueCheckSkipped) {
    showInfo(`${ISSUE_CHECKED_LABEL} が付いているので /issue-check を飛ばします`)
  } else {
    const issueCheckStatus = await runIssueCheckSession(issueNumber, stopController.signal)
    record.issueCheckExitCode = issueCheckStatus.exitCode
    record.issueCheckSignal = issueCheckStatus.signal
    if (!hasSessionSucceeded(issueCheckStatus)) {
      // 監査の結果が書き戻されたか分からないまま実装へ進むと、止めるべき Issue を実装しうる
      record.skippedReason = '/issue-check のセッションが失敗しました'
      return false
    }
    // 割るのに失敗して人間判断になった親も、できた子は引き継ぐ。人間判断は下の判定で記録に残す
    handOverToSubIssuesIfAny(issueNumber, record)
  }

  record.skippedReason = findReasonToSkipImplementation(readIssueStatus(issueNumber))
  if (record.skippedReason || record.subIssueHandover) return true

  // 前の実行が残した離脱の印を外し、CI を待つ前に付いていれば今回の離脱と読めるようにする
  runOrThrow('gh', [
    'issue',
    'edit',
    String(issueNumber),
    '--repo',
    config.repository,
    '--remove-label',
    NEEDS_CLEAN_SESSION_LABEL
  ])
  const autoDevStatus = await runAutoDevSession(issueNumber, stopController.signal)
  record.autoDevExitCode = autoDevStatus.exitCode
  record.autoDevSignal = autoDevStatus.signal
  return hasSessionSucceeded(autoDevStatus)
}

/**
 * Ctrl+C が来ない限り、指定した時間だけ待つ。Ctrl+C が来たら待たずに戻る。
 *
 * @param {number} milliseconds 待つ時間
 * @returns {Promise<void>}
 */
async function sleepUnlessStopped(milliseconds) {
  try {
    await sleep(milliseconds, undefined, { signal: stopController.signal })
  } catch (error) {
    if (!(error instanceof Error && error.name === 'AbortError')) throw error
  }
}

/**
 * リモートのトピックブランチが指している commit の SHA を引く。
 *
 * @param {string} branchName トピックブランチ名
 * @returns {string} commit の SHA（ブランチが push されていなければ空文字）
 * @throws {Error} git が失敗したとき
 */
function readRemoteHeadSha(branchName) {
  const output = runOrThrow('git', ['ls-remote', 'origin', `refs/heads/${branchName}`], {
    cwd: config.workspaceDir
  })
  return output.trim().split(/\s+/)[0] ?? ''
}

/**
 * commit に紐づく CI の run を一覧で引く。
 *
 * @param {string} headSha commit の SHA
 * @returns {{ databaseId: number, status: string, conclusion: string, headSha: string, url: string }[]} run の一覧
 * @throws {Error} gh が失敗したとき
 */
function listCiRuns(headSha) {
  // --branch は付けない。--commit と併せると、該当する run があっても空で返る
  return runJson('gh', [
    'run',
    'list',
    '--repo',
    config.repository,
    '--workflow',
    config.ci.workflowFile,
    '--commit',
    headSha,
    '--json',
    'databaseId,status,conclusion,headSha,url'
  ])
}

/**
 * commit の CI の run を1回引く。失敗しても投げず、理由を出して null を返す。
 *
 * @param {string} headSha 引く commit の SHA
 * @returns {ReturnType<typeof listCiRuns> | null} run の一覧（引けなければ null）
 */
function tryListCiRuns(headSha) {
  try {
    return listCiRuns(headSha)
  } catch (error) {
    showWarning(`CI の run を引けませんでした。引き直します: ${formatError(error)}`)
    return null
  }
}

/**
 * commit の CI の run が終わるまで待つ。待ち時間の上限を使い切るか、Ctrl+C が来たら、その時点の状態で戻る。
 * run を引けなかったときは、待ち時間の上限までは引き直す。
 *
 * @param {string} headSha 待つ commit の SHA
 * @returns {Promise<ReturnType<typeof readCiRunState>>} run の状態（終わらなかったときは pending）
 * @throws {Error} 上限まで引き直しても gh が失敗したとき
 */
async function waitForCiRun(headSha) {
  const deadline = Date.now() + CI_RUN_WAIT_LIMIT_MS
  const startedAt = Date.now()
  const showCiWaitProgress = createThrottledStatusLine({
    minAppendIntervalMs: CI_WAIT_PROGRESS_APPEND_INTERVAL_MS
  })
  for (;;) {
    const isLastTry = Date.now() >= deadline || stopController.signal.aborted
    // 待つ時間が長いほど瞬断や GitHub の一時障害に当たりやすい。1回の失敗でやめると、落ちた PR が誰にも直されずに残る。
    // 最後の1回だけは握らず、引けなかったこと自体を呼び出し元へ伝える
    const runs = isLastTry ? listCiRuns(headSha) : tryListCiRuns(headSha)
    if (runs === null) {
      await sleepUnlessStopped(CI_POLL_INTERVAL_MS)
      continue
    }
    const runState = readCiRunState(runs, headSha)
    if (runState.state !== 'pending' || isLastTry) return runState
    showCiWaitProgress(
      `CI 待ち… 経過 ${formatElapsedTime(Date.now() - startedAt)} / 上限${config.ci.runWaitLimitMinutes}分`
    )
    await sleepUnlessStopped(CI_POLL_INTERVAL_MS)
  }
}

/**
 * 上限まで直させても CI が落ちている Issue を、`/auto-dev` の離脱と同じ形で人間へ回す。
 *
 * @param {number} issueNumber 対象 Issue の番号
 * @param {{ url: string | null }} lastRun 最後に落ちた run
 * @returns {void}
 * @throws {Error} gh が失敗したとき
 */
function handOverToHuman(issueNumber, lastRun) {
  const body = `CI（${config.ci.workflowFile}）が、/auto-fix-ci で ${config.ci.maxFixAttempts} 回直させても通りませんでした。最後に落ちた run: ${lastRun.url}\n\n専用のセッションでこの Issue に着手してください。`
  runOrThrow('gh', [
    'issue',
    'comment',
    String(issueNumber),
    '--repo',
    config.repository,
    '--body',
    body
  ])
  runOrThrow('gh', [
    'issue',
    'edit',
    String(issueNumber),
    '--repo',
    config.repository,
    '--add-label',
    NEEDS_CLEAN_SESSION_LABEL
  ])
}

/**
 * CI を待つ前に、待っても意味が無い理由を探す。
 *
 * @param {{ issueNumber: number, headSha: string, previousHeadSha: string | null }} params 対象 Issue の番号・リモートのブランチの SHA（push されていなければ空文字）・前回待った SHA
 * @returns {string | null} 待たない理由（待ってよければ null）
 * @throws {Error} gh が失敗したとき
 */
function findReasonNotToWaitForCi({ issueNumber, headSha, previousHeadSha }) {
  // /auto-dev の起動前に外しているので、付いていれば今回の /auto-dev・/auto-fix-ci が離脱した印
  if (readIssueStatus(issueNumber).labelNames.includes(NEEDS_CLEAN_SESSION_LABEL)) {
    return `${NEEDS_CLEAN_SESSION_LABEL} が付いているので CI を待ちません`
  }
  if (!headSha) return 'ブランチが push されていないので CI を待ちません'
  if (headSha === previousHeadSha) return '/auto-fix-ci が push しませんでした'
  return null
}

/**
 * CI が通った Issue のカードをレビュー待ちへ動かし、記録に残す結果を返す。動かせなくても例外にしない。
 *
 * @param {string} itemId ボードのカード ID
 * @returns {string} 記録に残す CI の結果
 */
function handOverForReview(itemId) {
  const statusName = config.board.inReviewStatusName
  try {
    markAsInReview(itemId)
    return `CI が通りました。カードを ${statusName} へ動かしました`
  } catch (error) {
    return `CI が通りました。カードを ${statusName} へ動かせませんでした: ${formatError(error)}`
  }
}

/**
 * 直させずに終える run について、記録に残す結果を決める。通っていればレビュー待ちへ、上限まで直させても落ちていれば人間へ回す。
 *
 * @param {{ issue: { number: number, itemId: string }, nextStep: 'finish-passed' | 'hand-over' | 'stop-timed-out' | 'stop-unfixable', runState: { conclusion: string | null, url: string | null } }} params 対象 Issue・decideAfterCiRun の結果・待ち終えた run の状態
 * @returns {string} 記録に残す CI の結果
 * @throws {Error} 人間へ回すときに gh が失敗したとき
 */
function concludeCiWatch({ issue, nextStep, runState }) {
  switch (nextStep) {
    case 'finish-passed':
      return handOverForReview(issue.itemId)
    case 'stop-timed-out':
      return `CI の run が ${config.ci.runWaitLimitMinutes} 分以内に終わりませんでした（run が見つからない場合を含む）`
    case 'stop-unfixable':
      return `CI の run が ${runState.conclusion} で終わったので直させません`
    case 'hand-over':
      handOverToHuman(issue.number, runState)
      return `${config.ci.maxFixAttempts} 回直させても CI が通らないので人間へ回しました`
  }
}

/**
 * push した commit の CI を待ち、落ちていれば `/auto-fix-ci` に直させる。通るか、直させるのをやめるまで戻らない。
 * 結果は record へ書き足す。
 *
 * @param {{ number: number, itemId: string }} issue 対象 Issue
 * @param {string} branchName トピックブランチ名
 * @param {Record<string, unknown>} record 書き足す先の記録
 * @returns {Promise<boolean>} `/auto-fix-ci` を走らせなかったか、すべて正常終了したら true
 * @throws {Error} git・gh・claude を起動できなかった／失敗したとき
 */
async function watchCiAndFix(issue, branchName, record) {
  record.ciRuns = []
  // CI が通ったときだけ true にする。通らずに戻る経路（離脱・未 push・打ち切り）はどれも人間の手当てが要る
  record.isCiPassed = false
  let fixAttemptCount = 0
  let previousHeadSha = null
  for (;;) {
    const headSha = readRemoteHeadSha(branchName)
    const reasonNotToWait = findReasonNotToWaitForCi({
      issueNumber: issue.number,
      headSha,
      previousHeadSha
    })
    if (reasonNotToWait) {
      record.ciOutcome = reasonNotToWait
      return true
    }
    previousHeadSha = headSha

    showInfo(`CI を待ちます: ${config.ci.workflowFile} @ ${headSha.slice(0, 7)}`)
    const runState = await waitForCiRun(headSha)
    record.ciRuns.push({ headSha, ...runState })
    if (stopController.signal.aborted) {
      record.ciOutcome = 'CI を待つ途中で止めました'
      return true
    }

    const nextStep = decideAfterCiRun({
      state: runState.state,
      fixAttemptCount,
      maxFixAttempts: config.ci.maxFixAttempts
    })
    if (nextStep !== 'fix') {
      record.ciOutcome = concludeCiWatch({ issue, nextStep, runState })
      record.isCiPassed = nextStep === 'finish-passed'
      return true
    }

    fixAttemptCount += 1
    record.ciFixAttemptCount = fixAttemptCount
    const hasFixSessionSucceeded = await fixFailedCi({
      issueNumber: issue.number,
      runState,
      attemptNumber: fixAttemptCount,
      record
    })
    if (!hasFixSessionSucceeded) return false
  }
}

/**
 * 落ちた CI を `/auto-fix-ci` に直させる。結果は record へ書き足す。
 *
 * @param {{ issueNumber: number, runState: { runId: number, url: string }, attemptNumber: number, record: Record<string, unknown> }} params 対象 Issue の番号・落ちた CI の run・今回が何回目か・書き足す先の記録
 * @returns {Promise<boolean>} `/auto-fix-ci` のセッションが正常終了したら true
 * @throws {Error} claude を起動できなかったとき
 */
async function fixFailedCi({ issueNumber, runState, attemptNumber, record }) {
  showWarning(
    `CI が落ちました。/auto-fix-ci に直させます（${attemptNumber} 回目）: ${runState.url}`
  )
  const fixStatus = await runAutoFixCiSession({
    issueNumber,
    runId: runState.runId,
    abortSignal: stopController.signal
  })
  record.ciFixExitCode = fixStatus.exitCode
  record.ciFixSignal = fixStatus.signal
  if (hasSessionSucceeded(fixStatus)) return true
  record.ciOutcome = '/auto-fix-ci のセッションが失敗しました'
  return false
}

/**
 * 子への引き継ぎの結果を出す。1件も載せられなければ、人間に見てほしいこととして出す。
 *
 * @param {{ subIssueHandover: { reason: string, putOnReadySubIssueNumbers: number[] } }} record 記録した内容
 * @returns {void}
 */
function showSubIssueHandover(record) {
  const { reason, putOnReadySubIssueNumbers } = record.subIssueHandover
  const showHandover = isSubIssueHandoverEmpty(record) ? showWarning : showInfo
  showHandover(
    `実装せず子へ引き継ぎます: ${reason}。${config.board.readyStatusName} に載せた子は ${putOnReadySubIssueNumbers.length} 件です`
  )
}

/**
 * 着手中へ動かした Issue 1件を監査し、止める理由が無ければ実装させ、CI が通るまで直させる。途中で落ちても結果を記録する。
 *
 * @param {{ issue: { itemId: string, number: number, title: string }, branchName: string, existingPullRequestNumbers: Set<number> }} startedIssue startFirstStartableIssue の結果
 * @returns {Promise<boolean>} 走らせた claude セッションがすべて正常終了したら true（起動できなかった・打ち切られた・0 以外で終わった・途中で例外が出たら false）
 * @throws {Error} 記録ファイルへ書けなかったとき
 */
async function runSessionAndRecord({ issue, branchName, existingPullRequestNumbers }) {
  const record = { issueNumber: issue.number, issueTitle: issue.title, branchName }
  record.sessionStartedAt = new Date().toISOString()
  let isAllSessionsSucceeded = false
  try {
    // 途中で例外が出たら false のまま残すため、最後にまとめて代入する
    const isImplemented = await handOverOrImplement(issue.number, record)
    if (record.subIssueHandover) showSubIssueHandover(record)
    if (record.skippedReason) showWarning(`実装へ進みません: ${record.skippedReason}`)
    const shouldWatchCi = isImplemented && !record.skippedReason && !record.subIssueHandover
    isAllSessionsSucceeded = shouldWatchCi
      ? await watchCiAndFix(issue, branchName, record)
      : isImplemented
  } catch (error) {
    // 無人実行の画面はセッションの出力で流れるため、スタックを出すと原因の1行が埋もれる（Issue #780）
    record.error = formatError(error)
    record.errorStack = formatError(error, { withStack: true })
    showError(`#${issue.number} の処理が落ちました: ${collapseToSingleLine(record.error)}`)
  } finally {
    record.pullRequestUrl = findCreatedPullRequestUrl(branchName, existingPullRequestNumbers)
    record.finishedAt = new Date().toISOString()
    recordRun(record)
    showRunSummary(record, isAllSessionsSucceeded)
  }
  return isAllSessionsSucceeded
}

/**
 * 自動マージされた PR が閉じ損ねた Issue を閉じる。失敗しても投げない。close した Issue は
 * 状態変化として1件ごとに表示するが、何も無かったときは何も出さない（アイドル中の連投を避ける）。
 *
 * @returns {void}
 */
function tryCloseIssuesOfMergedPullRequests() {
  try {
    closeIssuesOfMergedPullRequests({
      repository: config.repository,
      onClosed: ({ issueNumber, pullRequestNumber }) =>
        showInfo(`#${issueNumber} を close しました（PR #${pullRequestNumber}）`)
    })
  } catch (error) {
    showWarning(`マージ済み PR の Issue を閉じられませんでした: ${formatError(error)}`)
  }
}

/**
 * 着手できない周が上限を超えていなければ、ボードを見直すまで待つ。待つ間は待機中のステータス行を出す。
 * 上限を超えていたら、待たずに止める理由を警告に出して true を返す。戻り値を捨てて周回を続けると、
 * 眠らずに gh を呼び続ける。Ctrl+C が来たら待たずに戻る。
 *
 * @param {number} idlePollCount 連続して着手しなかった回数（今回を含む）
 * @param {string} idleReason 待機中のステータス行に出す理由
 * @returns {Promise<boolean>} 上限を超えたので止めるなら true
 */
async function waitUnlessIdleWaitLimitReached(idlePollCount, idleReason) {
  if (stopController.signal.aborted) return false
  const maxConsecutiveIdleWaits = config.maxConsecutiveIdleWaits
  if (decideAfterIdlePoll({ idlePollCount, maxConsecutiveIdleWaits }) === 'stop') {
    // pollIntervalMinutes は利用先が小数で書き換えるので、掛け算の誤差（3.3000000000000003 など）を丸める
    const idleMinutes = Number((maxConsecutiveIdleWaits * config.pollIntervalMinutes).toFixed(1))
    showWarning(
      `着手できない状態が ${maxConsecutiveIdleWaits} 回（約 ${idleMinutes} 分）続いたので止めます。` +
        '直前の警告・エラーを読み、カードを Ready へ動かすか原因を直してから、もう一度 npm run auto-programmer を打ってください'
    )
    return true
  }
  showStatusLine(`待機中（${idleReason}）· ${idlePollCount}/${maxConsecutiveIdleWaits}回目`)
  await sleepUnlessStopped(POLL_INTERVAL_MS)
  return false
}

async function main() {
  // 上限が欠けたまま動かさない。config.mjs はテンプレート同期の対象外で、同期した利用先では欠けうる
  validateMaxConsecutiveIdleWaits(config.maxConsecutiveIdleWaits)
  // OS のアイドルスリープで sessionTimeoutMinutes の壁時計タイムアウトが実際の経過時間より早く
  // 効いてしまう（Issue #651）のを防ぐ。index.mjs の生存期間全体に掛かるよう、ここで1回だけ呼ぶ
  startSleepGuard()
  runPreflight()

  let consecutiveSessionFailureCount = 0
  let idlePollCount = 0
  let isIdleWaitLimitReached = false
  while (!stopController.signal.aborted && !isIdleWaitLimitReached) {
    tryCloseIssuesOfMergedPullRequests()
    let startedIssue
    // 候補を引けなかった回は「着手できる Issue が無い」とは別の理由なので、待機行に書き分ける。
    // 書き分けないと、gh の失敗などで待ち続けている間も「正常に空振りしている」ように見える
    let idleReason = '着手できる Issue なし'
    try {
      startedIssue = await startFirstStartableIssue()
    } catch (error) {
      showError(`候補を引けませんでした: ${formatError(error, { withStack: true })}`)
      idleReason = '候補を引けず、次の見直しで再試行'
    }
    if (!startedIssue) {
      idlePollCount += 1
      isIdleWaitLimitReached = await waitUnlessIdleWaitLimitReached(idlePollCount, idleReason)
      continue
    }
    idlePollCount = 0

    const isAllSessionsSucceeded = await runSessionAndRecord(startedIssue)
    consecutiveSessionFailureCount = isAllSessionsSucceeded ? 0 : consecutiveSessionFailureCount + 1
    if (consecutiveSessionFailureCount >= MAX_CONSECUTIVE_SESSION_FAILURES) {
      throw new Error(
        `claude のセッションが ${consecutiveSessionFailureCount} 回続けて失敗しました。記録の issueCheckExitCode・issueCheckSignal・autoDevExitCode・autoDevSignal・ciFixExitCode・ciFixSignal・error を読んで原因を直し、もう一度打ってください`
      )
    }
    await yieldToEventLoop()
  }
  showInfo('止めました')
}

try {
  await main()
} catch (error) {
  showError(formatError(error, { withStack: true }))
  process.exitCode = 1
}
