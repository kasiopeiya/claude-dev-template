#!/usr/bin/env node
// 責務: ボードの着手待ちのカードから Issue を1件ずつ拾い、AI 専用 clone で実装させ、CI の通った PR まで到達させる唯一の入口。
//   衝突して止まった自分の PR も解かせ直す。
//
// 設計意図（WHY）:
// - 拾う・順序を決める・記録するはすべてここで決定論的に行う。AI に任せると、同じ盤面から毎回
//   違う Issue を拾い、何が起きたかを追えなくなる。AI に渡すのは Issue 1件の監査・実装・CI の修正・衝突の解消だけ。
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
// - カードを「レビュー待ち」へは動かさない。PR が Issue に紐づいた時点で、ボードの組み込みワークフロー
//   「Pull request linked to issue」が動かす（Issue #995）。CI の通過を待って動かすと、同じ移動が二重になる。
// - 毎周、Issue を選ぶ前に、自動マージされた PR が閉じ損ねた Issue を閉じる（Issue #744）。起動時の1回だけだと、
//   回っている間にマージされた PR の Issue が閉じず、それを「ブロッカー」に持つ Issue がいつまでも拾われない。
//   閉じられなくても次の Issue は選べるので、失敗しても周回は止めない。
// - 予定した終わり方以外で終えた Issue には、記録を残す前に `needs-human-check` を付ける（どれを予定とするかは
//   needsHumanCheck.mjs）。カードの列だけでは止まった Issue を引けない（Issue #1000）。このツールが付けるのは記録の直前と、
//   シグナルで終わる直前（finally に届かない）の2か所だけにする。止まり方ごとに付けると、例外で落ちた経路が付け漏れる。
// - 同じマシンで何本も動かせるよう、起動時に一番小さい空き番号の AI 専用 clone をロックで取り、終わるまでその clone だけを使う。
//   1つの clone を共有すると、一方の作業中にもう一方が stash・reset --hard・clean を走らせる。clone ごと分ければ
//   workspace.mjs の巻き戻しの手順を変えずに済む。番号を自動で取るのは、人間に番号を選ばせず、clone の数を同時に動かした数の最大値で止めるため。
// - 並べたプロセスが同じ Issue を取り合わないよう、候補を選んだ直後、ブランチを準備する前に Issue ごとのロックを取り、CI 待ちと修正まで
//   含めて1件を終えるまで持つ。カードを先に着手中へ動かす手では、動かすのが一瞬で終わらず、同時に起動した2本が同じ候補を引く。
//   ロックを取った後にカードの Status を引き直すのは、候補を1周に1回しか引かないためである。他のプロセスが短い経路（子への引き継ぎ・
//   `/issue-check` での停止）で数十秒で終えてロックを外すと、古い候補一覧で同じ Issue を取り直せてしまう。
//   ロックはこのマシンの中でしか効かない。別のマシンで同じアカウントを動かすと取り合う。
// - 毎周、Issue を選ぶ前に、このツールが作った PR のうち、先にマージされた別の PR と衝突して止まったものを探し、1件ずつ
//   `/auto-resolve-conflict` に解かせてから CI を待つ（Issue #1076）。CI が通った時点で手放すので、後から衝突しても誰も気づかない。
//   新しい Issue より先に片付けるのは、止まった PR の Issue をブロッカーに持つ Issue が、それまで拾われないためである。
//   取り合わないよう、衝突を解かせる間も同じ Issue のロックを持つ。

import { basename, dirname, join } from 'node:path'
import { setImmediate as yieldToEventLoop, setTimeout as sleep } from 'node:timers/promises'

import { closeIssuesOfMergedPullRequests } from '../close-issues.mjs'
import {
  listStartableIssues,
  markCardAsStarted,
  putOnReadyAssignedToMe,
  readCardStatusName
} from './board.mjs'
import { buildBranchName, validateBranchPrefix } from './branchName.mjs'
import {
  runAutoDevSession,
  runAutoFixCiSession,
  runAutoResolveConflictSession,
  runIssueCheckSession
} from './claudeSession.mjs'
import { config } from './config.mjs'
import {
  collectOwnPullRequestsByUrl,
  CONFLICT_CHECK_PULL_REQUEST_FIELDS,
  findReasonNotToResolveConflict,
  selectConflictedOwnPullRequests
} from './conflictedPullRequest.mjs'
import { decideAfterIdlePoll, validateMaxConsecutiveIdleWaits } from './idleWait.mjs'
import {
  findSkipImplementationDecision,
  ISSUE_CHECKED_LABEL,
  HUMAN_ONLY_LABELS
} from './issueCheckVerdict.mjs'
import { CI_RUN_STATE_FIELDS, decideAfterCiRun, readCiRunState } from './ciRun.mjs'
import { findDecisionNotToWaitForCi } from './ciWaitDecision.mjs'
import {
  acquireLowestFreeNumberedLockFile,
  releaseLockFile,
  tryAcquireNamedLockFile
} from './pidLockFile.mjs'
import {
  isSubIssueHandoverEmpty,
  NEEDS_HUMAN_CHECK_LABEL,
  shouldMarkAsNeedsHumanCheck
} from './needsHumanCheck.mjs'
import { ensureDependencies, runPreflight } from './preflight.mjs'
import { readRunRecords, recordRun } from './runLog.mjs'
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
import { alignLabeledValues, collapseToSingleLine, formatElapsedTime } from './uiFormat.mjs'
import { prepareTopicBranch, switchToPullRequestBranch } from './workspace.mjs'

const MILLISECONDS_PER_SECOND = 1000
const MILLISECONDS_PER_MINUTE = 60 * MILLISECONDS_PER_SECOND

// 候補が無かったときに、ボードを見直すまで待つ時間
const POLL_INTERVAL_MS = config.pollIntervalMinutes * MILLISECONDS_PER_MINUTE

const CI_POLL_INTERVAL_MS = config.ci.pollIntervalSeconds * MILLISECONDS_PER_SECOND
const CI_RUN_WAIT_LIMIT_MS = config.ci.runWaitLimitMinutes * MILLISECONDS_PER_MINUTE

// 非TTY で CI 待ちの経過を追記する間隔。CI_POLL_INTERVAL_MS のまま追記すると、
// 上限（runWaitLimitMinutes）いっぱい待つ実行で数十行に膨らむ
const CI_WAIT_PROGRESS_APPEND_INTERVAL_MS = 5 * MILLISECONDS_PER_MINUTE

// AI 専用 clone の番号ロックと、Issue ごとのロックの置き場。config.mjs はテンプレート同期の対象外で、同期した利用先では古い形のまま
// 動くので、キーを足さずに既存の workspaceDir から導く。置き場は clone の親（AUTO_PROGRAMMER_HOME）の下で、clone の名前ごとに分ける
const LOCK_DIRECTORY = join(dirname(config.workspaceDir), 'locks', basename(config.workspaceDir))

// 着手できる Issue が無い周に、待機中のステータス行へ出す理由
const NO_STARTABLE_ISSUE_IDLE_REASON = '着手できる Issue なし'

// GraphQL が1つの接続（sub-issue・ラベル・カード）から一度に返せる件数の上限。sub-issue は超えていたら読み落としとして止める
const GRAPHQL_CONNECTION_FETCH_LIMIT = 100

// 衝突した PR を探すときに引く open な PR の上限。gh pr list の既定の30件では、人間のレビュー待ちが溜まると取りこぼす
const OPEN_PULL_REQUEST_FETCH_LIMIT = 200

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
// 着手中の Issue の番号（着手中でなければ null）。シグナルで終わると runWorkAndRecord の finally に届かないので、
// 止まった印はリスナが付ける
let inFlightIssueNumber = null
// このプロセスが取った AI 専用 clone の番号ロック（取る前と外した後は null）。シグナルで終わると main の finally に
// 届かないので、リスナも外す
let workspaceLock = null
// このプロセスが着手している Issue のロック（取る前と外した後は null）。外す理由は workspaceLock と同じ
let issueLock = null
// 衝突した PR ごとに、最後に出した飛ばす理由（showConflictSkipReasonOnce が同じ行を毎周出さないためのもの）
const shownConflictSkipReasonsByPullRequestNumber = new Map()
for (const signal of ['SIGHUP', 'SIGTERM', 'SIGQUIT']) {
  process.once(signal, () => {
    stopController.abort(signal)
    if (inFlightIssueNumber !== null) tryMarkAsNeedsHumanCheck(inFlightIssueNumber, {})
    releaseIssueLock()
    releaseWorkspaceLock()
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
 * ブランチを head とするマージ済みの PR の番号を引く。
 *
 * @param {string} branchName トピックブランチ名
 * @returns {number | null} マージ済みの PR の番号（無ければ null）
 * @throws {Error} gh が失敗したとき
 */
function findMergedPullRequestNumber(branchName) {
  const [mergedPullRequest] = runJson('gh', [
    'pr',
    'list',
    '--repo',
    config.repository,
    '--head',
    branchName,
    '--state',
    'merged',
    '--json',
    'number'
  ])
  return mergedPullRequest?.number ?? null
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
  const {
    data: { repository, viewer }
  } = runJson('gh', [
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
  const { totalCount, nodes } = repository.issue.subIssues
  if (totalCount > nodes.length) {
    throw new Error(
      `#${issueNumber} の sub-issue ${totalCount} 件のうち ${nodes.length} 件しか読めていません。読み落とした子を載せ損ねるため止めます`
    )
  }
  return { viewerLogin: viewer.login, subIssues: nodes.map(toSubIssue) }
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
    humanOnlyLabels: HUMAN_ONLY_LABELS,
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
 * @param {{ issueNumber: number, sessionStartedAt: string, finishedAt: string, pullRequestUrl: string | null, ciOutcome?: string, isCiPassed?: boolean, isClosedWithoutChanges?: boolean, skippedReason?: string | null, isSkippedByIssueCheckVerdict?: boolean, subIssueHandover?: { reason: string, putOnReadySubIssueNumbers: number[] }, error?: string }} record 記録した内容
 * @param {boolean} isAllSessionsSucceeded 走らせた claude セッションがすべて正常終了したか
 * @returns {void}
 */
function showRunSummary(record, isAllSessionsSucceeded) {
  const elapsedTime = formatElapsedTime(
    Date.parse(record.finishedAt) - Date.parse(record.sessionStartedAt)
  )
  const headline = `#${record.issueNumber} を終えました（${elapsedTime}）`
  // /issue-check の判定で止めた Issue は予定した終わり方だが、人間判断・close を見てほしいので警告で出す
  const needsHumanAttention =
    Boolean(record.skippedReason) || shouldMarkAsNeedsHumanCheck(record, isAllSessionsSucceeded)
  if (record.error) showError(headline)
  else if (needsHumanAttention) showWarning(headline)
  else showSuccess(headline)

  // 値が同じ桁から始まるよう、項目名の幅を揃えてから行ごとのレベルで出す
  /* eslint-disable id-denylist -- { label, value } は「項目名と値の組」で、value が正しい語（#900） */
  const details = []
  if (record.ciOutcome) {
    details.push({
      label: 'CI',
      value: record.ciOutcome,
      show: record.isCiPassed || record.isClosedWithoutChanges ? showInfo : showWarning
    })
  }
  if (record.pullRequestUrl === null) {
    details.push({ label: 'PR', value: '有無は GitHub で確かめてください', show: showWarning })
  } else {
    details.push({
      label: 'PR',
      value: record.pullRequestUrl || '作られませんでした',
      show: showInfo
    })
  }
  details.push({ label: '記録', value: config.runLogPath, show: showInfo })
  /* eslint-enable id-denylist */
  const lines = alignLabeledValues(details)
  details.forEach(({ show }, index) => show(lines[index]))
}

/**
 * 落ちうるローカルの準備をすべて済ませてから、カードを着手中へ動かす。
 *
 * @param {{ issue: { itemId: string, number: number, labelNames: string[] }, branchName: string, workspaceDir: string }} params 対象 Issue・作るトピックブランチ名・このプロセスが使う AI 専用 clone
 * @returns {Set<number>} 着手前からあった PR の番号
 * @throws {Error} 着手中へ動かすまでの処理が落ちたとき（カードは着手待ちのまま残る）
 */
function startIssue({ issue, branchName, workspaceDir }) {
  prepareTopicBranch({ workspaceDir, branchName })
  ensureDependencies(workspaceDir)
  const existingPullRequestNumbers = new Set(
    listPullRequests(branchName).map(({ number }) => number)
  )
  markCardAsStarted(issue.itemId)
  return existingPullRequestNumbers
}

/** @typedef {{ issue: { itemId: string, number: number, title: string }, branchName: string, workspaceDir: string, existingPullRequestNumbers: Set<number> }} StartedIssue 着手中へ動かした Issue。そのロックは issueLock に残り、1件を終えたら releaseIssueLock で外す */

/**
 * 他のプロセスと取り合わないよう Issue のロックを取る。取れたら issueLock に残す。
 *
 * Issue の実装と衝突の解消は、同じこのロックで互いを締め出す。ロック名を片方だけ変えると、同じ Issue で両方が同時に走る。
 *
 * @param {number} issueNumber Issue の番号
 * @returns {string | null} 取れなかったときの飛ばす理由（取れたら null）
 * @throws {Error} ロックファイルを読めなかった・作れなかった・消せなかったとき
 */
function tryAcquireIssueLock(issueNumber) {
  const { lock, holderPid } = tryAcquireNamedLockFile({
    lockDirectory: LOCK_DIRECTORY,
    lockName: `issue-${issueNumber}`
  })
  if (lock === null) return `PID ${holderPid ?? '（読めず）'} のプロセスが着手中です`
  issueLock = lock
  return null
}

/**
 * 他のプロセスと取り合わないよう Issue のロックを取り、カードがまだ着手待ちかを引き直す。
 *
 * 着手してよいとき・投げたときは、取ったロックを issueLock に残す。カードがもう着手待ちに無いときは、外してから理由を返す。
 *
 * @param {{ itemId: string, number: number }} issue 候補の Issue
 * @returns {string | null} 着手せずに飛ばす理由（他のプロセスがロックを持っている・カードがもう着手待ちに無い。着手してよければ null）
 * @throws {Error} ロックファイルを読めなかった・作れなかった・消せなかったとき・カードの Status を引けなかったとき
 */
function claimIssue(issue) {
  const lockSkipReason = tryAcquireIssueLock(issue.number)
  if (lockSkipReason) return lockSkipReason

  const statusName = readCardStatusName(issue.itemId)
  if (statusName === config.board.readyStatusName) return null
  releaseIssueLock()
  return `カードがもう ${config.board.readyStatusName} にありません（いまは ${statusName ?? 'Status なし'}）`
}

/**
 * Issue 1件の着手を試す。他のプロセスが着手している・カードがもう着手待ちに無ければ ℹ で、着手前の準備が落ちれば ⚠ で理由を出して飛ばす。
 *
 * 着手したときは、その Issue のロックを issueLock に残す。
 *
 * @param {{ itemId: string, number: number, title: string, labelNames: string[] }} issue 候補の Issue
 * @param {string} workspaceDir このプロセスが使う AI 専用 clone
 * @returns {{ outcome: 'started', startedIssue: StartedIssue } | { outcome: 'skipped' } | { outcome: 'failed' }} 着手した（started）・異常ではない理由で飛ばした（skipped）・着手前の準備が落ちて飛ばした（failed）のどれか
 */
function tryStartIssue(issue, workspaceDir) {
  try {
    const skipReason = claimIssue(issue)
    if (skipReason) {
      showInfo(`#${issue.number} を飛ばします: ${skipReason}`)
      return { outcome: 'skipped' }
    }
    const branchName = buildBranchName({
      issueNumber: issue.number,
      labelNames: issue.labelNames,
      branchPrefix: config.branchPrefix
    })
    showIssueBanner({ issueNumber: issue.number, title: issue.title, branchName, workspaceDir })
    const existingPullRequestNumbers = startIssue({ issue, branchName, workspaceDir })
    return {
      outcome: 'started',
      startedIssue: { issue, branchName, workspaceDir, existingPullRequestNumbers }
    }
  } catch (error) {
    // 持ったまま飛ばすと、このプロセスが動いている間、他のプロセスもこの Issue を試せない
    releaseIssueLock()
    showWarning(`#${issue.number} を飛ばします: ${formatError(error)}`)
    return { outcome: 'failed' }
  }
}

/**
 * 着手できる Issue を着手順に試し、最初に着手中へ動かせた1件を返す。
 *
 * 他のプロセスが着手している・カードがもう着手待ちに無い Issue と、着手前に落ちた Issue は、理由を出して飛ばす。着手できる Issue が
 * 無いときは何も出さない（呼び出し側がアイドル中のステータス行にまとめて示す）。前者のせいだけで全件を飛ばしたときは、
 * 異常ではないので締めの警告を出さない。
 *
 * 着手した Issue のロックは issueLock に残す。外すのは呼び出し側で、1件を終えたときに releaseIssueLock を呼ぶ。
 *
 * @param {string} workspaceDir このプロセスが使う AI 専用 clone
 * @returns {Promise<{ startedIssue: StartedIssue | null, idleReason: string | null }>} 着手した Issue（着手できる Issue が無い・全部飛ばした・止められたときは null）と、着手しなかったときに待機中のステータス行へ出す理由（着手したときは null）
 * @throws {Error} 候補を引けなかったとき
 */
async function startFirstStartableIssue(workspaceDir) {
  const issues = listStartableIssues()
  let failedIssueCount = 0
  for (const issue of issues) {
    // 同期処理の合間にイベントループを回し、Ctrl+C を受け取る
    await yieldToEventLoop()
    if (stopController.signal.aborted) {
      return { startedIssue: null, idleReason: NO_STARTABLE_ISSUE_IDLE_REASON }
    }

    const result = tryStartIssue(issue, workspaceDir)
    if (result.outcome === 'started') {
      return { startedIssue: result.startedIssue, idleReason: null }
    }
    if (result.outcome === 'failed') failedIssueCount += 1
  }

  const isAllSkippedWithoutFailure = issues.length > 0 && failedIssueCount === 0
  if (isAllSkippedWithoutFailure) return { startedIssue: null, idleReason: '他のプロセスが着手中' }
  if (failedIssueCount > 0) showWarning(`着手できる Issue ${issues.length} 件をすべて飛ばしました`)
  return { startedIssue: null, idleReason: NO_STARTABLE_ISSUE_IDLE_REASON }
}

/**
 * open な sub-issue を持つなら子を着手待ちに載せて終える。そうでなければ `issue:checked` が無いときだけ `/issue-check` を通し、
 * 監査が割っていれば子を着手待ちに載せ、止める理由も子も無ければ `/auto-dev` を走らせる。結果は record へ書き足す。
 *
 * record を引数で受けるのは、途中で例外が出ても、そこまでの結果を呼び出し側が記録できるようにするため。
 *
 * @param {number} issueNumber 対象 Issue の番号
 * @param {string} workspaceDir claude セッションを動かす AI 専用 clone
 * @param {Record<string, unknown>} record 書き足す先の記録
 * @returns {Promise<boolean>} 走らせた claude セッションがすべて正常終了したら true
 * @throws {Error} claude を起動できなかったとき・Issue のラベルを外せなかった／引き直せなかったとき・sub-issue を引けなかった／子を着手待ちに載せられなかったとき
 */
async function handOverOrImplement(issueNumber, workspaceDir, record) {
  handOverToSubIssuesIfAny(issueNumber, record)
  // 監査前の親のラベルは止める理由の判定に通さない。`/to-issues` のまとめ用の親は issue:checked を持たないことがある
  if (record.subIssueHandover) return true

  record.issueCheckSkipped = readIssueStatus(issueNumber).labelNames.includes(ISSUE_CHECKED_LABEL)
  if (record.issueCheckSkipped) {
    showInfo(`${ISSUE_CHECKED_LABEL} が付いているので /issue-check を飛ばします`)
  } else {
    const issueCheckStatus = await runIssueCheckSession({
      issueNumber,
      workspaceDir,
      abortSignal: stopController.signal
    })
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

  const skipDecision = findSkipImplementationDecision(
    readIssueStatus(issueNumber),
    config.targetIssueLabel
  )
  record.skippedReason = skipDecision?.reason ?? null
  if (skipDecision) record.isSkippedByIssueCheckVerdict = skipDecision.isVerdict
  if (record.skippedReason || record.subIssueHandover) return true

  // 前の実行が止まって残した印を外し、CI を待つ前に付いていれば今回の離脱と読めるようにする
  runOrThrow('gh', [
    'issue',
    'edit',
    String(issueNumber),
    '--repo',
    config.repository,
    '--remove-label',
    NEEDS_HUMAN_CHECK_LABEL
  ])
  const autoDevStatus = await runAutoDevSession({
    issueNumber,
    workspaceDir,
    abortSignal: stopController.signal
  })
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
 * @param {{ workspaceDir: string, branchName: string }} params origin を引く AI 専用 clone と、トピックブランチ名
 * @returns {string} commit の SHA（ブランチが push されていなければ空文字）
 * @throws {Error} git が失敗したとき
 */
function readRemoteHeadSha({ workspaceDir, branchName }) {
  const output = runOrThrow('git', ['ls-remote', 'origin', `refs/heads/${branchName}`], {
    cwd: workspaceDir
  })
  return output.trim().split(/\s+/)[0] ?? ''
}

/**
 * 接頭辞と同じ名前のブランチがリモートに無いことを確かめる。
 *
 * git は refs/heads/<接頭辞> があると refs/heads/<接頭辞>/... を作れない。ライン名（main2 など）をそのまま接頭辞に
 * 入れると、着手して AI のセッションを使い切ってから push で拒否されるので、起動時に止める。
 *
 * @param {{ branchPrefix: string | undefined, workspaceDir: string }} params config.mjs の `branchPrefix`（検査済み）と、origin を引く AI 専用 clone
 * @returns {void}
 * @throws {Error} 接頭辞と同じ名前のブランチがリモートにあるとき・git が失敗したとき
 */
function ensureNoBranchNamedAsPrefix({ branchPrefix, workspaceDir }) {
  if (!branchPrefix) return
  const sameNameBranch = runOrThrow(
    'git',
    ['ls-remote', '--heads', 'origin', `refs/heads/${branchPrefix}`],
    {
      cwd: workspaceDir
    }
  )
  if (sameNameBranch.trim() === '') return
  throw new Error(
    `scripts/auto-programmer/config.mjs の branchPrefix（${branchPrefix}）と同じ名前のブランチが ${config.repository} にあるため、${branchPrefix}/... のブランチを作れません。ライン名と重ならない接頭辞にしてください`
  )
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
    CI_RUN_STATE_FIELDS
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
 * 上限まで直させても CI が落ちている Issue に、`/auto-dev` の離脱と同じく、人間へ回す理由をコメントする。
 * `needs-human-check` は、記録を残す前に runWorkAndRecord が付ける。
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
}

/**
 * 直させずに終える run について、記録に残す結果を決める。上限まで直させても落ちていれば人間へ回す。
 *
 * @param {{ issueNumber: number, nextStep: 'finish-passed' | 'hand-over' | 'stop-timed-out' | 'stop-unfixable', runState: { conclusion: string | null, url: string | null } }} params 対象 Issue の番号・decideAfterCiRun の結果・待ち終えた run の状態
 * @returns {string} 記録に残す CI の結果
 * @throws {Error} 人間へ回すときに gh が失敗したとき
 */
function concludeCiWatch({ issueNumber, nextStep, runState }) {
  switch (nextStep) {
    case 'finish-passed':
      return 'CI が通りました'
    case 'stop-timed-out':
      return `CI の run が ${config.ci.runWaitLimitMinutes} 分以内に終わりませんでした（run が見つからない場合を含む）`
    case 'stop-unfixable':
      return `CI の run が ${runState.conclusion} で終わったので直させません`
    case 'hand-over':
      handOverToHuman(issueNumber, runState)
      return `${config.ci.maxFixAttempts} 回直させても CI が通らないので人間へ回しました`
  }
}

/**
 * リモートのブランチ・clone の HEAD・Issue を引き、CI を待っても意味が無い理由を探す。
 *
 * @param {{ issueNumber: number, branchName: string, workspaceDir: string, previousHeadSha: string | null, lastSessionName: string }} params 対象 Issue の番号・トピックブランチ名・作業している AI 専用 clone・push されなかったとみなす SHA と直前に走らせたセッションの名前（findDecisionNotToWaitForCi を参照）
 * @returns {{ headSha: string, decisionNotToWait: ReturnType<typeof findDecisionNotToWaitForCi> }} リモートのブランチの SHA と、記録にそのまま書く待たない理由（待ってよければ null）
 * @throws {Error} git・gh が失敗したとき
 */
function readHeadShaAndDecisionNotToWait({
  issueNumber,
  branchName,
  workspaceDir,
  previousHeadSha,
  lastSessionName
}) {
  const headSha = readRemoteHeadSha({ workspaceDir, branchName })
  const localHeadSha = runOrThrow('git', ['rev-parse', 'HEAD'], { cwd: workspaceDir }).trim()
  const { state, labelNames } = readIssueStatus(issueNumber)
  // マージで消えたブランチを、差分が出ずに閉じた Issue と見分けるためだけに引く。ブランチが残っていれば要らない
  const mergedPullRequestNumber = headSha ? null : findMergedPullRequestNumber(branchName)
  return {
    headSha,
    decisionNotToWait: findDecisionNotToWaitForCi({
      state,
      labelNames,
      headSha,
      localHeadSha,
      previousHeadSha,
      lastSessionName,
      mergedPullRequestNumber
    })
  }
}

/**
 * push した commit の CI を待ち、落ちていれば `/auto-fix-ci` に直させる。通るか、直させるのをやめるまで戻らない。
 * 結果は record へ書き足す。
 *
 * @param {{ issueNumber: number, branchName: string, workspaceDir: string, headShaBeforeSession: string | null, sessionName: string }} target 対象 Issue の番号・トピックブランチ名・作業している AI 専用 clone・セッションの前のリモートのブランチの SHA（これと同じなら push されなかったとみなす。新しく作ったブランチなら null）・CI を待つ前に走らせたセッションの名前
 * @param {Record<string, unknown>} record 書き足す先の記録
 * @returns {Promise<boolean>} `/auto-fix-ci` を走らせなかったか、すべて正常終了したら true
 * @throws {Error} git・gh・claude を起動できなかった／失敗したとき
 */
async function watchCiAndFix(
  { issueNumber, branchName, workspaceDir, headShaBeforeSession, sessionName },
  record
) {
  record.ciRuns = []
  // CI が通ったとき（PR がマージ済みのときを含む）だけ true にする。通らずに戻る経路（離脱・未 push・打ち切り）は、
  // 差分が出ずに閉じた場合を除いて人間の手当てが要る
  record.isCiPassed = false
  let fixAttemptCount = 0
  // 衝突を解かせた後は、push されなかった古い SHA の CI（通った後に衝突したもの）を、解けた印と取り違えない
  const pushCheck = { previousHeadSha: headShaBeforeSession, lastSessionName: sessionName }
  for (;;) {
    const { headSha, decisionNotToWait } = readHeadShaAndDecisionNotToWait({
      issueNumber,
      branchName,
      workspaceDir,
      ...pushCheck
    })
    if (decisionNotToWait) {
      Object.assign(record, decisionNotToWait)
      return true
    }
    pushCheck.previousHeadSha = headSha

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
      record.ciOutcome = concludeCiWatch({ issueNumber, nextStep, runState })
      record.isCiPassed = nextStep === 'finish-passed'
      return true
    }

    fixAttemptCount += 1
    pushCheck.lastSessionName = '/auto-fix-ci'
    const hasFixSessionSucceeded = await fixFailedCi({
      issueNumber,
      workspaceDir,
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
 * @param {{ issueNumber: number, workspaceDir: string, runState: { runId: number, url: string }, attemptNumber: number, record: Record<string, unknown> }} params 対象 Issue の番号・セッションを動かす AI 専用 clone・落ちた CI の run・今回が何回目か・書き足す先の記録
 * @returns {Promise<boolean>} `/auto-fix-ci` のセッションが正常終了したら true
 * @throws {Error} claude を起動できなかったとき
 */
async function fixFailedCi({ issueNumber, workspaceDir, runState, attemptNumber, record }) {
  record.ciFixAttemptCount = attemptNumber
  showWarning(
    `CI が落ちました。/auto-fix-ci に直させます（${attemptNumber} 回目）: ${runState.url}`
  )
  const fixStatus = await runAutoFixCiSession({
    issueNumber,
    runId: runState.runId,
    workspaceDir,
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
 * Issue に `needs-human-check` を付け、付けられたかを record へ書き足す。付けられなくても投げない。
 *
 * runWorkAndRecord の finally から呼ぶので、投げるとその1件の記録が残らない。
 *
 * @param {number} issueNumber 対象 Issue の番号
 * @param {Record<string, unknown>} record 書き足す先の記録
 * @returns {void}
 */
function tryMarkAsNeedsHumanCheck(issueNumber, record) {
  try {
    runOrThrow('gh', [
      'issue',
      'edit',
      String(issueNumber),
      '--repo',
      config.repository,
      '--add-label',
      NEEDS_HUMAN_CHECK_LABEL
    ])
    record.isMarkedAsNeedsHumanCheck = true
  } catch (error) {
    record.isMarkedAsNeedsHumanCheck = false
    record.needsHumanCheckLabelError = formatError(error)
    showWarning(
      `#${issueNumber} に ${NEEDS_HUMAN_CHECK_LABEL} を付けられませんでした: ${collapseToSingleLine(record.needsHumanCheckLabelError)}`
    )
  }
}

/**
 * Issue 1件ぶんの作業を走らせ、途中で落ちても結果を記録する。予定した終わり方以外で終えたら、記録の前に `needs-human-check` を付ける
 * （付けられなくても投げない）。
 *
 * @param {{ record: Record<string, unknown> & { issueNumber: number }, runWork: (record: Record<string, unknown>) => Promise<boolean>, readPullRequestUrl: () => string | null }} params 記録の初期値・作業（受け取った記録へ結果を書き足し、走らせた claude セッションがすべて正常終了したら true を返す）・記録に残す PR の URL を引く関数（作業の後に呼ぶ）
 * @returns {Promise<boolean>} 走らせた claude セッションがすべて正常終了したら true（起動できなかった・打ち切られた・0 以外で終わった・途中で例外が出たら false）
 * @throws {Error} 記録ファイルへ書けなかったとき
 */
async function runWorkAndRecord({ record, runWork, readPullRequestUrl }) {
  record.sessionStartedAt = new Date().toISOString()
  inFlightIssueNumber = record.issueNumber
  let isAllSessionsSucceeded = false
  try {
    isAllSessionsSucceeded = await runWork(record)
  } catch (error) {
    // 無人実行の画面はセッションの出力で流れるため、スタックを出すと原因の1行が埋もれる（Issue #780）
    record.error = formatError(error)
    record.errorStack = formatError(error, { withStack: true })
    showError(`#${record.issueNumber} の処理が落ちました: ${collapseToSingleLine(record.error)}`)
  } finally {
    record.pullRequestUrl = readPullRequestUrl()
    record.finishedAt = new Date().toISOString()
    if (shouldMarkAsNeedsHumanCheck(record, isAllSessionsSucceeded)) {
      tryMarkAsNeedsHumanCheck(record.issueNumber, record)
    }
    recordRun(record)
    inFlightIssueNumber = null
    showRunSummary(record, isAllSessionsSucceeded)
  }
  return isAllSessionsSucceeded
}

/**
 * 着手中へ動かした Issue 1件を監査し、止める理由が無ければ実装させ、CI が通るまで直させる。結果は record へ書き足す。
 *
 * @param {StartedIssue} startedIssue startFirstStartableIssue の結果
 * @param {Record<string, unknown>} record 書き足す先の記録
 * @returns {Promise<boolean>} 走らせた claude セッションがすべて正常終了したら true
 * @throws {Error} git・gh・claude を起動できなかった／失敗したとき
 */
async function implementAndWatchCi(startedIssue, record) {
  const { issue, branchName, workspaceDir } = startedIssue
  const isImplemented = await handOverOrImplement(issue.number, workspaceDir, record)
  if (record.subIssueHandover) showSubIssueHandover(record)
  if (record.skippedReason) showWarning(`実装へ進みません: ${record.skippedReason}`)
  const shouldWatchCi = isImplemented && !record.skippedReason && !record.subIssueHandover
  if (!shouldWatchCi) return isImplemented
  // ブランチは着手時にデフォルトブランチから作り直しているので、push されていれば最初の SHA から待ってよい
  return watchCiAndFix(
    {
      issueNumber: issue.number,
      branchName,
      workspaceDir,
      headShaBeforeSession: null,
      sessionName: '/auto-dev'
    },
    record
  )
}

/**
 * 着手中へ動かした Issue 1件を実装させて CI まで見届け、結果を記録する（記録の決まりは runWorkAndRecord）。
 *
 * @param {StartedIssue} startedIssue startFirstStartableIssue の結果
 * @returns {Promise<boolean>} 走らせた claude セッションがすべて正常終了したら true
 * @throws {Error} 記録ファイルへ書けなかったとき
 */
function implementIssueAndRecord(startedIssue) {
  const { issue, branchName, workspaceDir, existingPullRequestNumbers } = startedIssue
  return runWorkAndRecord({
    // 記録ファイルは全プロセスで共有するので、どの clone で作業したかを載せる。途中で消えた変更の stash を探す先になる
    record: { issueNumber: issue.number, issueTitle: issue.title, branchName, workspaceDir },
    runWork: (record) => implementAndWatchCi(startedIssue, record),
    readPullRequestUrl: () => findCreatedPullRequestUrl(branchName, existingPullRequestNumbers)
  })
}

/**
 * このツールが作った open な PR のうち、衝突しているものを引く。
 *
 * @returns {ReturnType<typeof selectConflictedOwnPullRequests>} 衝突を解かせる候補（PR 番号の小さい順）
 * @throws {Error} 記録ファイルを読めなかった・gh が失敗したとき
 */
function listConflictedOwnPullRequests() {
  const ownPullRequestsByUrl = collectOwnPullRequestsByUrl(readRunRecords())
  // 待機中も毎周ここを通るので、まだ PR を作っていなければ gh を呼ばない
  if (ownPullRequestsByUrl.size === 0) return []
  const openPullRequests = runJson('gh', [
    'pr',
    'list',
    '--repo',
    config.repository,
    '--state',
    'open',
    '--limit',
    String(OPEN_PULL_REQUEST_FETCH_LIMIT),
    '--json',
    CONFLICT_CHECK_PULL_REQUEST_FIELDS
  ])
  // gh は新しい PR から返すので、上限で切れると、長く止まっている古い PR から読み落とす
  if (openPullRequests.length >= OPEN_PULL_REQUEST_FETCH_LIMIT) {
    showWarning(
      `open な PR が ${OPEN_PULL_REQUEST_FETCH_LIMIT} 件以上あります。古い PR の衝突を読み落としているかもしれません`
    )
  }
  return selectConflictedOwnPullRequests({ openPullRequests, ownPullRequestsByUrl })
}

/**
 * 衝突した PR を引く。引けなくても投げず、理由を出して空にする（Issue の着手へ進む）。
 *
 * @returns {ReturnType<typeof listConflictedOwnPullRequests>} 衝突を解かせる候補（引けなければ空）
 */
function tryListConflictedOwnPullRequests() {
  try {
    return listConflictedOwnPullRequests()
  } catch (error) {
    showWarning(`衝突した PR を探せませんでした。Issue の着手へ進みます: ${formatError(error)}`)
    return []
  }
}

/**
 * PR の state・mergeable・head の SHA と、auto-merge が有効かを引き直す。
 *
 * @param {number} pullRequestNumber PR の番号
 * @returns {{ state: string, mergeable: string, headSha: string, isAutoMergeEnabled: boolean }} state（'OPEN' など）・mergeable（'CONFLICTING' など）・head の SHA・auto-merge が有効か
 * @throws {Error} gh が失敗したとき
 */
function readPullRequestStatus(pullRequestNumber) {
  const { state, mergeable, headRefOid, autoMergeRequest } = runJson('gh', [
    'pr',
    'view',
    String(pullRequestNumber),
    '--repo',
    config.repository,
    '--json',
    'state,mergeable,headRefOid,autoMergeRequest'
  ])
  return { state, mergeable, headSha: headRefOid, isAutoMergeEnabled: autoMergeRequest !== null }
}

/**
 * 衝突した PR を飛ばす理由を ℹ で出す。同じ PR に同じ理由を出したことがあれば出さない。
 *
 * `needs-human-check` が付いた・別の push があった PR は、人間が手を入れるまで理由が変わらず、待機中も毎周ここを通る。
 * 毎周出すと、待機中の出力が同じ行で埋まり、新しく起きた異常を見つけにくくなる。
 *
 * @param {{ pullRequestNumber: number, subject: string, reason: string }} params PR の番号・行の頭に出す対象・飛ばす理由
 * @returns {void}
 */
function showConflictSkipReasonOnce({ pullRequestNumber, subject, reason }) {
  if (shownConflictSkipReasonsByPullRequestNumber.get(pullRequestNumber) === reason) return
  shownConflictSkipReasonsByPullRequestNumber.set(pullRequestNumber, reason)
  showInfo(`${subject}を飛ばします: ${reason}`)
}

/** @typedef {ReturnType<typeof selectConflictedOwnPullRequests>[number] & { headShaBeforeSession: string, isAutoMergeEnabled: boolean }} ClaimedConflictedPullRequest 衝突を解かせると決めた PR。その Issue のロックは issueLock に残り、解き終えたら releaseIssueLock で外す */

/**
 * 衝突した PR の Issue のロックを取り、PR と Issue を読み直して、まだ解かせてよいかを確かめる。飛ばすときは理由を出す。
 *
 * 解かせてよいときは、取ったロックを issueLock に残す。それ以外は外す。
 *
 * @param {ReturnType<typeof selectConflictedOwnPullRequests>[number]} candidate 衝突を解かせる候補
 * @returns {ClaimedConflictedPullRequest | null} 解かせると決めた PR（飛ばしたら null）
 */
function tryClaimConflictedPullRequest(candidate) {
  const { issueNumber, pullRequestNumber, lastWaitedHeadSha } = candidate
  const subject = `PR #${pullRequestNumber}（#${issueNumber}）の衝突`
  try {
    const lockSkipReason = tryAcquireIssueLock(issueNumber)
    if (lockSkipReason) {
      showConflictSkipReasonOnce({ pullRequestNumber, subject, reason: lockSkipReason })
      return null
    }
    const pullRequest = readPullRequestStatus(pullRequestNumber)
    const reason = findReasonNotToResolveConflict({
      pullRequest,
      issue: { number: issueNumber, ...readIssueStatus(issueNumber) },
      lastWaitedHeadSha,
      needsHumanCheckLabel: NEEDS_HUMAN_CHECK_LABEL
    })
    if (reason === null) {
      const { headSha, isAutoMergeEnabled } = pullRequest
      return { ...candidate, headShaBeforeSession: headSha, isAutoMergeEnabled }
    }
    releaseIssueLock()
    showConflictSkipReasonOnce({ pullRequestNumber, subject, reason })
    return null
  } catch (error) {
    // 持ったまま飛ばすと、このプロセスが動いている間、他のプロセスもこの Issue を試せない
    releaseIssueLock()
    showWarning(`${subject}を飛ばします: ${formatError(error)}`)
    return null
  }
}

/**
 * 衝突している自分の PR を PR 番号の小さい順に試し、最初に解かせると決めた1件を返す。
 *
 * @returns {Promise<ClaimedConflictedPullRequest | null>} 解かせると決めた PR（無い・全部飛ばした・止められたときは null）
 */
async function claimFirstConflictedPullRequest() {
  for (const candidate of tryListConflictedOwnPullRequests()) {
    // 同期処理の合間にイベントループを回し、Ctrl+C を受け取る
    await yieldToEventLoop()
    if (stopController.signal.aborted) return null
    const conflictedPullRequest = tryClaimConflictedPullRequest(candidate)
    if (conflictedPullRequest) return conflictedPullRequest
  }
  return null
}

/**
 * PR の auto-merge を外す。
 *
 * @param {number} pullRequestNumber PR の番号
 * @returns {void}
 * @throws {Error} gh が失敗したとき
 */
function disableAutoMerge(pullRequestNumber) {
  runOrThrow('gh', [
    'pr',
    'merge',
    String(pullRequestNumber),
    '--repo',
    config.repository,
    '--disable-auto'
  ])
  showInfo(
    `PR #${pullRequestNumber} の auto-merge を外しました。解いた後の CI が通ると、pr-ai-triage が中身を見て付け直します`
  )
}

/**
 * 衝突した PR のブランチへ切り替えて `/auto-resolve-conflict` に解かせ、push されたら CI が通るまで直させる。結果は record へ書き足す。
 *
 * @param {{ conflictedPullRequest: ClaimedConflictedPullRequest, workspaceDir: string }} params 解かせると決めた PR と、このプロセスが使う AI 専用 clone
 * @param {Record<string, unknown>} record 書き足す先の記録
 * @returns {Promise<boolean>} 走らせた claude セッションがすべて正常終了したら true
 * @throws {Error} git・gh・claude を起動できなかった／失敗したとき
 */
async function resolveConflictAndWatchCi({ conflictedPullRequest, workspaceDir }, record) {
  const { issueNumber, pullRequestNumber, branchName, headShaBeforeSession, isAutoMergeEnabled } =
    conflictedPullRequest
  // 外さずに解くと、解いた push の CI が通った瞬間、pr-ai-triage が中身を見る前にマージされうる。
  // 外したことを記録に残す。push されずに終わると pr-ai-triage が走らず、外れたまま残るので、人間が記録から気づけるようにする
  if (isAutoMergeEnabled) {
    disableAutoMerge(pullRequestNumber)
    record.isAutoMergeDisabled = true
  }
  // リモートの最新ではなく、確かめた commit へ切り替える。確かめた後に入った push の中身を、無人セッションで走らせない
  switchToPullRequestBranch({ workspaceDir, branchName, headSha: headShaBeforeSession })
  ensureDependencies(workspaceDir)
  const resolveStatus = await runAutoResolveConflictSession({
    issueNumber,
    workspaceDir,
    abortSignal: stopController.signal
  })
  record.conflictResolutionExitCode = resolveStatus.exitCode
  record.conflictResolutionSignal = resolveStatus.signal
  if (!hasSessionSucceeded(resolveStatus)) return false
  return watchCiAndFix(
    {
      issueNumber,
      branchName,
      workspaceDir,
      headShaBeforeSession,
      sessionName: '/auto-resolve-conflict'
    },
    record
  )
}

/**
 * 衝突した PR 1件を解かせて CI まで見届け、結果を記録する（記録の決まりは runWorkAndRecord）。
 *
 * @param {{ conflictedPullRequest: ClaimedConflictedPullRequest, workspaceDir: string }} params 解かせると決めた PR と、このプロセスが使う AI 専用 clone
 * @returns {Promise<boolean>} 走らせた claude セッションがすべて正常終了したら true
 * @throws {Error} 記録ファイルへ書けなかったとき
 */
function resolveConflictAndRecord({ conflictedPullRequest, workspaceDir }) {
  const { issueNumber, pullRequestNumber, pullRequestUrl, branchName } = conflictedPullRequest
  showIssueBanner({
    issueNumber,
    title: `PR #${pullRequestNumber} の衝突を解く`,
    branchName,
    workspaceDir
  })
  return runWorkAndRecord({
    record: { issueNumber, branchName, workspaceDir, isConflictResolution: true },
    runWork: (record) => resolveConflictAndWatchCi({ conflictedPullRequest, workspaceDir }, record),
    // 解いた後も PR の URL を記録に残し、次に衝突したときもこのツールの PR として見分ける
    readPullRequestUrl: () => pullRequestUrl
  })
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

/**
 * 一番小さい空き番号の AI 専用 clone をロックで取り、その clone のパスを返す。1番は config.workspaceDir をそのまま、
 * 2番以降はその後ろに `-<番号>` を付けたパスにする。取ったロックは releaseWorkspaceLock で外す。
 *
 * @returns {string} このプロセスが使う AI 専用 clone（まだ無ければ preflight が作る）
 * @throws {Error} ロックファイルを読めなかった・作れなかった・消せなかったとき
 */
function acquireWorkspaceDir() {
  const { lockNumber, lock } = acquireLowestFreeNumberedLockFile({
    lockDirectory: LOCK_DIRECTORY,
    lockFileNamePrefix: 'workspace'
  })
  workspaceLock = lock
  const workspaceDir =
    lockNumber === 1 ? config.workspaceDir : `${config.workspaceDir}-${lockNumber}`
  showInfo(`AI 専用 clone の ${lockNumber} 番を使います: ${workspaceDir}`)
  return workspaceDir
}

/**
 * ロックを外す。外せなくても投げない。
 *
 * シグナルのリスナからも呼ぶので、投げるとシグナルでの終了に至らない。外せずに残ったロックは、PID のプロセスが
 * いなくなった時点で、次に取ろうとしたプロセスが死んだとみなして取り直す。
 *
 * @param {Parameters<typeof releaseLockFile>[0]} lock 外すロック
 * @returns {void}
 */
function tryReleaseLockFile(lock) {
  try {
    releaseLockFile(lock)
  } catch (error) {
    showWarning(`ロック ${lock.lockFilePath} を外せませんでした: ${formatError(error)}`)
  }
}

/**
 * 取った AI 専用 clone の番号ロックを外す。取っていなければ何もしない。外せなくても投げない。
 *
 * @returns {void}
 */
function releaseWorkspaceLock() {
  if (workspaceLock === null) return
  tryReleaseLockFile(workspaceLock)
  workspaceLock = null
}

/**
 * 着手している Issue のロックを外す。取っていなければ何もしない。外せなくても投げない。
 *
 * @returns {void}
 */
function releaseIssueLock() {
  if (issueLock === null) return
  tryReleaseLockFile(issueLock)
  issueLock = null
}

/**
 * 次にする作業を1つ選び、その Issue のロックを取る。衝突した自分の PR を、新しい Issue より先に選ぶ。
 *
 * 選んだ作業の Issue のロックは issueLock に残す。外すのは呼び出し側で、作業を終えたときに releaseIssueLock を呼ぶ。
 *
 * @param {string} workspaceDir このプロセスが使う AI 専用 clone
 * @returns {Promise<{ runWork: (() => Promise<boolean>) | null, idleReason: string | null }>} 作業を走らせて記録する関数（する作業が無いときは null）と、
 *   作業が無いときに待機中のステータス行へ出す理由（作業があるときは null）
 */
async function claimNextWork(workspaceDir) {
  // 止まった PR を先に片付ける。後回しにすると、その Issue をブロッカーに持つ Issue がいつまでも拾われない
  const conflictedPullRequest = await claimFirstConflictedPullRequest()
  if (conflictedPullRequest) {
    return {
      runWork: () => resolveConflictAndRecord({ conflictedPullRequest, workspaceDir }),
      idleReason: null
    }
  }
  try {
    const { startedIssue, idleReason } = await startFirstStartableIssue(workspaceDir)
    if (!startedIssue) return { runWork: null, idleReason }
    return { runWork: () => implementIssueAndRecord(startedIssue), idleReason: null }
  } catch (error) {
    // 候補を引けなかった回は「着手できる Issue が無い」とは別の理由なので、待機行に書き分ける。
    // 書き分けないと、gh の失敗などで待ち続けている間も「正常に空振りしている」ように見える
    showError(`候補を引けませんでした: ${formatError(error, { withStack: true })}`)
    return { runWork: null, idleReason: '候補を引けず、次の見直しで再試行' }
  }
}

/**
 * Ctrl+C が来るか、着手できない周が上限を超えるまで、衝突した PR を解かせるか Issue を拾うかを1件ずつ処理する。
 *
 * @param {string} workspaceDir このプロセスが使う AI 専用 clone
 * @returns {Promise<void>}
 * @throws {Error} claude のセッションが続けて失敗したとき・記録ファイルへ書けなかったとき
 */
async function processIssuesUntilStopped(workspaceDir) {
  let consecutiveSessionFailureCount = 0
  let idlePollCount = 0
  let isIdleWaitLimitReached = false
  while (!stopController.signal.aborted && !isIdleWaitLimitReached) {
    tryCloseIssuesOfMergedPullRequests()
    const { runWork, idleReason } = await claimNextWork(workspaceDir)
    if (!runWork) {
      idlePollCount += 1
      isIdleWaitLimitReached = await waitUnlessIdleWaitLimitReached(idlePollCount, idleReason)
      continue
    }
    idlePollCount = 0

    let isAllSessionsSucceeded
    try {
      isAllSessionsSucceeded = await runWork()
    } finally {
      releaseIssueLock()
    }
    consecutiveSessionFailureCount = isAllSessionsSucceeded ? 0 : consecutiveSessionFailureCount + 1
    if (consecutiveSessionFailureCount >= MAX_CONSECUTIVE_SESSION_FAILURES) {
      throw new Error(
        `claude のセッションが ${consecutiveSessionFailureCount} 回続けて失敗しました。記録の issueCheckExitCode・issueCheckSignal・autoDevExitCode・autoDevSignal・ciFixExitCode・ciFixSignal・conflictResolutionExitCode・conflictResolutionSignal・error を読んで原因を直し、もう一度打ってください`
      )
    }
    await yieldToEventLoop()
  }
}

async function main() {
  // 上限が欠けたまま動かさない。config.mjs はテンプレート同期の対象外で、同期した利用先では欠けうる
  validateMaxConsecutiveIdleWaits(config.maxConsecutiveIdleWaits)
  // 不正な接頭辞は buildBranchName が Issue ごとに投げ、catch で「飛ばします」になって全 Issue を飛ばし続ける。
  // Issue を拾う前に止める
  validateBranchPrefix(config.branchPrefix)
  // OS のアイドルスリープで sessionTimeoutMinutes の壁時計タイムアウトが実際の経過時間より早く
  // 効いてしまう（Issue #651）のを防ぐ。index.mjs の生存期間全体に掛かるよう、ここで1回だけ呼ぶ
  startSleepGuard()
  // clone を作る preflight より前に取る。後だと、同時に起動した2本が同じ clone を作り始める
  const workspaceDir = acquireWorkspaceDir()
  try {
    runPreflight(workspaceDir)
    // リモートを見るので clone ができた後に確かめる
    ensureNoBranchNamedAsPrefix({ branchPrefix: config.branchPrefix, workspaceDir })
    await processIssuesUntilStopped(workspaceDir)
  } finally {
    releaseWorkspaceLock()
  }
  showInfo('止めました')
}

try {
  await main()
} catch (error) {
  showError(formatError(error, { withStack: true }))
  process.exitCode = 1
}
