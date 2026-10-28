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
//   claude のセッションが続けて失敗したときも止まる（MAX_CONSECUTIVE_SESSION_FAILURES）。
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
//   確かめるのは `/issue-check` の前・後と `/auto-dev` の後である。前は割り済みの親に監査の費用を掛けないため。
//   `/issue-check` の後は今回の監査が割った分を、`/auto-dev` の後は実装フローの `/issue-split` が割った分を拾うため。
//   親のカードは着手中のまま残す。子が進んでいる間、親は作業中である。
// - Issue 1件の行き先（引き継いだ・見送った・実装した・セッション失敗）は、handOverOrImplement が戻り値で1か所に決める。
//   呼び出し側が record から同じ条件を組み直すと、止める理由を足したときに片方を直し忘れ、実装していない Issue の CI を待ちに行く。
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
// - Issue のロックは、取った関数が戻り値（StartedIssue・ClaimedConflictedPullRequest）で持ち主に渡す。作業まで進んだロックは
//   processIssuesUntilStopped の finally が、飛ばした候補のロックは候補を選ぶ側が、次の候補へ進む前に外す。飛ばした候補は
//   processIssuesUntilStopped へ戻らず、選ぶ側のループが次の候補へ進むので、finally 1か所には集められない。持ち主の見えない
//   変数に外す義務を預けると外し忘れが見えないので、変数に控えるのは、シグナルで終わる（finally に届かない）ときにリスナが外す
//   ためだけにする。その控えは issueLockKeeper の中に閉じ、取る・外す口もそこに絞る。
// - ロックの定義（置き場・取り方・外し方・控え）は processLocks.mjs が持つ。ここが決めるのは、周回でいつ取り・外すかである（シグナルで終わるときに外すのは stopSignals.mjs のリスナ）。
// - 終了シグナルは、受けるたびに実行中の claude セッションへ子孫ごと送る。AbortController は1度しか合図せず、Ctrl+C の後の SIGTERM は
//   届かないので、最初の1つは abort、2つ目以降はイベントで届ける（使い分けは shell.mjs の sendSignalToWatchedChildren に閉じる）。
//   Ctrl+C で止めた回は、セッションが打ち切られて失敗に見えるだけで、claude が壊れた兆候ではないので、連続失敗に数えない。
// - 終了シグナルのリスナと、リスナが中止する stopController・着手中の Issue の番号は、stopSignals.mjs が持つ。ここが決めるのは、リスナを
//   いつ付けるか（main の先頭）、いつ着手中の番号を控え・外すか（runWorkAndRecord）、stopSignal をどのセッション・待機に渡し、どこで
//   見て周回を抜けるかである。
// - gh の戻り値は、並び順を信じない。記録する PR は番号が最大のものを採る（gh は新しい順に返す）。

import { setImmediate as yieldToEventLoop, setTimeout as sleep } from 'node:timers/promises'

import { closeIssuesOfMergedPullRequests } from '../close-issues.mjs'
import { TechnicalError } from '../lib/errors.mjs'
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
import { findReasonNotToResolveConflict } from './conflictedPullRequest.mjs'
import { tryListConflictedOwnPullRequests } from './conflictedPullRequestClaim.mjs'
import { decideAfterIdlePoll, validateMaxConsecutiveIdleWaits } from './idleWait.mjs'
import { validateSessionModelSettings } from './sessionModel.mjs'
import {
  findSkipImplementationDecision,
  ISSUE_CHECKED_LABEL,
  HUMAN_ONLY_LABELS
} from './issueCheckVerdict.mjs'
import { listSubIssues, readIssueStatus } from './issueQuery.mjs'
import {
  commentOnIssue,
  removeNeedsHumanCheckLabel,
  tryMarkAsNeedsHumanCheck
} from './issueWrite.mjs'
import {
  buildHandOverComment,
  decideAfterCiRun,
  describeCiOutcome,
  readCiRunState
} from './ciRun.mjs'
import { listCiRuns, tryListCiRuns } from './ciRunQuery.mjs'
import { findDecisionNotToWaitForCi } from './ciWaitDecision.mjs'
import {
  isSubIssueHandoverEmpty,
  NEEDS_HUMAN_CHECK_LABEL,
  shouldMarkAsNeedsHumanCheck
} from './needsHumanCheck.mjs'
import { ensureDependencies, runPreflight } from './preflight.mjs'
import { acquireWorkspaceDir, issueLockKeeper, releaseWorkspaceLock } from './processLocks.mjs'
import {
  disableAutoMerge,
  findMergedPullRequest,
  listPullRequests,
  readPullRequestStatus
} from './pullRequestQuery.mjs'
import { recordRun } from './runLog.mjs'
import { runOrThrow } from './shell.mjs'
import { startSleepGuard } from './sleepGuard.mjs'
import {
  clearInFlightIssueNumber,
  installStopSignalListeners,
  setInFlightIssueNumber,
  stopSignal
} from './stopSignals.mjs'
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
import {
  alignLabeledValues,
  collapseToSingleLine,
  formatElapsedTime,
  formatErrorMessage,
  formatErrorWithStack
} from './uiFormat.mjs'
import { prepareTopicBranch, switchToPullRequestBranch } from './workspace.mjs'

const MILLISECONDS_PER_SECOND = 1000
const MILLISECONDS_PER_MINUTE = 60 * MILLISECONDS_PER_SECOND

const IDLE_BOARD_POLL_INTERVAL_MS = config.pollIntervalMinutes * MILLISECONDS_PER_MINUTE

const CI_POLL_INTERVAL_MS = config.ci.pollIntervalSeconds * MILLISECONDS_PER_SECOND
const CI_RUN_WAIT_LIMIT_MS = config.ci.runWaitLimitMinutes * MILLISECONDS_PER_MINUTE

// 非TTY で CI 待ちの経過を追記する間隔。CI_POLL_INTERVAL_MS のまま追記すると、
// 上限（runWaitLimitMinutes）いっぱい待つ実行で数十行に膨らむ
const CI_WAIT_PROGRESS_APPEND_INTERVAL_MS = 5 * MILLISECONDS_PER_MINUTE

// 着手できる Issue が無い周に、待機中のステータス行へ出す理由
const NO_STARTABLE_ISSUE_IDLE_REASON = '着手できる Issue なし'

// セッションがこの回数続けて失敗したら止める。claude 側が壊れている（ログイン切れ・利用上限など）と、
// 待たずに次のカードを着手中へ送り、Ready のカードを PR 無しのまま使い切るため
const MAX_CONSECUTIVE_SESSION_FAILURES = 2

// 衝突した PR ごとに、最後に出した飛ばす理由（showConflictSkipReasonOnce が同じ行を毎周出さないためのもの）
const shownConflictSkipReasonsByPullRequestNumber = new Map()

/**
 * 設定を検査して AI 専用 clone を取り、Ctrl+C か着手できない周の上限で止まるまで、衝突した PR を解かせるか Issue を拾うかを1件ずつ処理する。
 *
 * @returns {Promise<void>}
 * @throws {TechnicalError} 設定が欠けている・不正なとき、接頭辞と同じ名前のブランチがリモートにあるとき、claude のセッションが続けて失敗したとき
 * @throws {Error} ロックファイルを扱えなかったとき・人間が済ませるべき準備や clone が整わなかったとき・git・gh が失敗したとき・記録ファイルへ書けなかったとき
 */
async function main() {
  // clone の番号ロックを取る前に付ける。リスナが、取ったロックを外す
  installStopSignalListeners()
  // 上限が欠けたまま動かさない。config.mjs はテンプレート同期の対象外で、同期した利用先では欠けうる
  validateMaxConsecutiveIdleWaits(config.maxConsecutiveIdleWaits)
  // 不正な接頭辞は buildBranchName が Issue ごとに投げ、catch で「飛ばします」になって全 Issue を飛ばし続ける。
  // Issue を拾う前に止める
  validateBranchPrefix(config.branchPrefix)
  // 欠けたまま動かすと settings.json を継ぎ、対話の /model に引きずられる。Issue を拾う前に止める
  validateSessionModelSettings(config)
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
  showError(formatErrorWithStack(error))
  process.exitCode = 1
}

/**
 * open な sub-issue を持つ Issue なら、子のうち載せてよいものを着手待ちに載せ、担当者を自分にする。結果を record.subIssueHandover へ書く。
 *
 * @param {number} issueNumber 対象 Issue の番号
 * @param {Record<string, unknown>} record 書き足す先の記録
 * @returns {void} open な sub-issue が無ければ record に何も書かない
 * @throws {TechnicalError} sub-issue が一度に読める件数を超えたとき
 * @throws {Error} gh が失敗したとき・ボードの表記が config.mjs と食い違うとき
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
 * 複数あるときは、番号が最大（最後に作られた）のものを採る。
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
    // gh pr list は新しい順に返すが、並び順に頼らず、作られた順に増える番号で最新を選ぶ
    const latestCreatedPullRequest = created.reduce(
      (latestSoFar, pullRequest) =>
        latestSoFar && latestSoFar.number > pullRequest.number ? latestSoFar : pullRequest,
      null
    )
    return latestCreatedPullRequest ? latestCreatedPullRequest.url : ''
  } catch (error) {
    showWarning(`PR の有無を確かめられませんでした: ${formatErrorMessage(error)}`)
    return null
  }
}

/**
 * Issue 1件の締めとして、所要時間・CI の結果・PR・記録先をまとめて表示する。
 *
 * 締めの記号は、例外の有無だけでなく「人間の手当てが要るか」で決める。実装が失敗しても例外は出ない
 * （セッションが 0 以外で終わるだけ）ので、例外だけで決めると失敗した実行に ✓ が出て、異常が埋もれる。
 *
 * @param {{ issueNumber: number, sessionStartedAt: string, finishedAt: string, pullRequestUrl: string | null, ciOutcome?: string, isCiPassed?: boolean, isClosedWithoutChanges?: boolean, reasonNotToImplement?: string | null, isSkippedByIssueCheckVerdict?: boolean, subIssueHandover?: { reason: string, putOnReadySubIssueNumbers: number[] }, error?: string }} record 記録した内容
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
    Boolean(record.reasonNotToImplement) ||
    shouldMarkAsNeedsHumanCheck(record, isAllSessionsSucceeded)
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

/** @typedef {import('./processLocks.mjs').IssueLock} IssueLock */

/** @typedef {{ issue: { itemId: string, number: number, title: string }, branchName: string, workspaceDir: string, existingPullRequestNumbers: Set<number>, issueLock: IssueLock }} StartedIssue 着手中へ動かした Issue。そのロックは issueLock に載り、1件を終えたら呼び出し側が外す */

/**
 * ロックを取った後に、カードがまだ着手待ちにあるかを引き直す。
 *
 * 引き直すのは、候補を1周に1回しか引かないためである（冒頭の設計意図）。
 *
 * @param {{ itemId: string }} issue 候補の Issue
 * @returns {string | null} カードがもう着手待ちに無いときの飛ばす理由（着手待ちにあれば null）
 * @throws {Error} カードの Status を引けなかったとき
 */
function findReasonCardIsNoLongerReady(issue) {
  const statusName = readCardStatusName(issue.itemId)
  if (statusName === config.board.readyStatusName) return null
  return `カードがもう ${config.board.readyStatusName} にありません（いまは ${statusName ?? 'Status なし'}）`
}

/**
 * Issue 1件の着手を試す。他のプロセスが着手している・カードがもう着手待ちに無ければ ℹ で、着手前の準備が落ちれば ⚠ で理由を出して飛ばす。
 *
 * 着手したときは、取ったロックを startedIssue に載せて返す。飛ばしたときは、次の候補へ進む前にここで外す。
 *
 * @param {{ itemId: string, number: number, title: string, labelNames: string[] }} issue 候補の Issue
 * @param {string} workspaceDir このプロセスが使う AI 専用 clone
 * @returns {{ outcome: 'started', startedIssue: StartedIssue } | { outcome: 'skipped' } | { outcome: 'failed' }} 着手した（started）・異常ではない理由で飛ばした（skipped）・着手前の準備が落ちて飛ばした（failed）のどれか
 */
function tryStartIssue(issue, workspaceDir) {
  let issueLock = null
  let isStarted = false
  try {
    const lockAttempt = issueLockKeeper.tryAcquire(issue.number)
    issueLock = lockAttempt.lock
    const skipReason = lockAttempt.skipReason ?? findReasonCardIsNoLongerReady(issue)
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
    isStarted = true
    return {
      outcome: 'started',
      startedIssue: { issue, branchName, workspaceDir, existingPullRequestNumbers, issueLock }
    }
  } catch (error) {
    showWarning(`#${issue.number} を飛ばします: ${formatErrorMessage(error)}`)
    return { outcome: 'failed' }
  } finally {
    // 持ったまま飛ばすと、このプロセスが動いている間、他のプロセスもこの Issue を試せない
    if (!isStarted) issueLockKeeper.release(issueLock)
  }
}

/**
 * 着手できる Issue を着手順に試し、最初に着手中へ動かせた1件を返す。
 *
 * 他のプロセスが着手している・カードがもう着手待ちに無い Issue と、着手前に落ちた Issue は、理由を出して飛ばす。着手できる Issue が
 * 無いときは何も出さない（呼び出し側がアイドル中のステータス行にまとめて示す）。前者のせいだけで全件を飛ばしたときは、
 * 異常ではないので締めの警告を出さない。
 *
 * 着手した Issue のロックは startedIssue に載せて返す。外すのは呼び出し側で、1件を終えたときに issueLockKeeper.release を呼ぶ。
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
    if (stopSignal.aborted) {
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
 * 監査が割っていれば子を着手待ちに載せ、止める理由も子も無ければ `/auto-dev` を走らせる。`/auto-dev` が commit せずに
 * 正常終了した後も、実装フローの `/issue-split` で子ができていれば子を着手待ちに載せる。結果は record へ書き足す。
 *
 * record を引数で受けるのは、途中で例外が出ても、そこまでの結果を呼び出し側が記録できるようにするため。
 *
 * @param {number} issueNumber 対象 Issue の番号
 * @param {string} workspaceDir claude セッションを動かす AI 専用 clone
 * @param {Record<string, unknown>} record 書き足す先の記録
 * @returns {Promise<'handed-over' | 'skipped' | 'implemented' | 'session-failed'>} 子へ引き継いだ（handed-over）・止める理由があって実装せず見送った（skipped）・`/auto-dev` が正常終了した（implemented。CI を待つのはこの回だけ）・claude のセッションが失敗した（session-failed）のどれか
 * @throws {Error} claude を起動できなかったとき・Issue のラベルを外せなかった／引き直せなかったとき・sub-issue を引けなかった／子を着手待ちに載せられなかったとき
 */
async function handOverOrImplement(issueNumber, workspaceDir, record) {
  handOverToSubIssuesIfAny(issueNumber, record)
  // 監査前の親のラベルは止める理由の判定に通さない。`/to-issues` のまとめ用の親は issue:checked を持たないことがある
  if (record.subIssueHandover) return 'handed-over'

  record.isIssueCheckSkipped = readIssueStatus(issueNumber).labelNames.includes(ISSUE_CHECKED_LABEL)
  if (record.isIssueCheckSkipped) {
    showInfo(`${ISSUE_CHECKED_LABEL} が付いているので /issue-check を飛ばします`)
  } else {
    const issueCheckStatus = await runIssueCheckSession({
      issueNumber,
      workspaceDir,
      abortSignal: stopSignal
    })
    record.issueCheckExitCode = issueCheckStatus.exitCode
    record.issueCheckSignal = issueCheckStatus.signal
    if (!hasSessionSucceeded(issueCheckStatus)) {
      // 監査の結果が書き戻されたか分からないまま実装へ進むと、止めるべき Issue を実装しうる
      record.reasonNotToImplement = '/issue-check のセッションが失敗しました'
      return 'session-failed'
    }
    // 割るのに失敗して人間判断になった親も、できた子は引き継ぐ。人間判断は下の判定で記録に残す
    handOverToSubIssuesIfAny(issueNumber, record)
  }

  const skipDecision = findSkipImplementationDecision(
    readIssueStatus(issueNumber),
    config.targetIssueLabel
  )
  record.reasonNotToImplement = skipDecision?.reason ?? null
  if (skipDecision) record.isSkippedByIssueCheckVerdict = skipDecision.isVerdict
  if (record.subIssueHandover) return 'handed-over'
  if (record.reasonNotToImplement) return 'skipped'

  // 前の実行が止まって残した印を外し、CI を待つ前に付いていれば今回の離脱と読めるようにする
  removeNeedsHumanCheckLabel(issueNumber)
  const headShaBeforeAutoDev = readLocalHeadSha(workspaceDir)
  const autoDevStatus = await runAutoDevSession({
    issueNumber,
    workspaceDir,
    abortSignal: stopSignal
  })
  record.autoDevExitCode = autoDevStatus.exitCode
  record.autoDevSignal = autoDevStatus.signal
  if (!hasSessionSucceeded(autoDevStatus)) return 'session-failed'
  // /auto-dev が /issue-split で割った親は、差分も commit も無いまま終わる。ここで拾わないと、作られた子が誰にも載せられない。
  // commit した回は PR の CI を待たせる。引き継ぐと 'handed-over' になって CI を待たず、落ちた PR が直されずに残る
  if (readLocalHeadSha(workspaceDir) === headShaBeforeAutoDev) {
    handOverToSubIssuesIfAny(issueNumber, record)
  }
  return record.subIssueHandover ? 'handed-over' : 'implemented'
}

/**
 * Ctrl+C が来ない限り、指定した時間だけ待つ。Ctrl+C が来たら待たずに戻る。
 *
 * @param {number} milliseconds 待つ時間
 * @returns {Promise<void>}
 */
async function sleepUnlessStopped(milliseconds) {
  try {
    await sleep(milliseconds, undefined, { signal: stopSignal })
  } catch (error) {
    if (!(error instanceof Error && error.name === 'AbortError')) throw error
  }
}

/**
 * AI 専用 clone の HEAD が指している commit の SHA を引く。
 *
 * @param {string} workspaceDir HEAD を引く AI 専用 clone
 * @returns {string} commit の SHA
 * @throws {Error} git が失敗したとき
 */
function readLocalHeadSha(workspaceDir) {
  return runOrThrow('git', ['rev-parse', 'HEAD'], { cwd: workspaceDir }).trim()
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
 * @throws {TechnicalError} 接頭辞と同じ名前のブランチがリモートにあるとき
 * @throws {Error} git が失敗したとき
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
  throw new TechnicalError(
    `scripts/auto-programmer/config.mjs の branchPrefix（${branchPrefix}）と同じ名前のブランチが ${config.repository} にあるため、${branchPrefix}/... のブランチを作れません。ライン名と重ならない接頭辞にしてください`
  )
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
    const isLastTry = Date.now() >= deadline || stopSignal.aborted
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
 * CI 待ちを終える。直させずに終える run の結果を record へ書き足し、上限まで直させても落ちていれば、書き足す前に人間へ回すコメントを Issue に付ける。
 *
 * @param {{ issueNumber: number, nextStep: 'finish-passed' | 'hand-over' | 'stop-timed-out' | 'stop-unfixable', runState: { conclusion: string | null, url: string | null }, record: Record<string, unknown> }} params 対象 Issue の番号・decideAfterCiRun の結果（直させる 'fix' は渡さない）・待ち終えた run の状態・書き足す先の記録
 * @returns {void}
 * @throws {Error} 人間へ回すときに gh が失敗したとき
 */
function finishCiWatch({ issueNumber, nextStep, runState, record }) {
  if (nextStep === 'hand-over') {
    commentOnIssue(
      issueNumber,
      buildHandOverComment({
        workflowFile: config.ci.workflowFile,
        maxFixAttempts: config.ci.maxFixAttempts,
        lastRunUrl: runState.url
      })
    )
  }
  record.ciOutcome = describeCiOutcome({
    nextStep,
    conclusion: runState.conclusion,
    runWaitLimitMinutes: config.ci.runWaitLimitMinutes,
    maxFixAttempts: config.ci.maxFixAttempts
  })
  record.isCiPassed = nextStep === 'finish-passed'
}

/**
 * リモートのブランチ・clone の HEAD・Issue を引き、CI を待っても意味が無い理由を探す。
 *
 * @param {{ issueNumber: number, branchName: string, workspaceDir: string, previousHeadSha: string | null, lastSessionName: string, workStartedAt: string }} params 対象 Issue の番号・トピックブランチ名・作業している AI 専用 clone・push されなかったとみなす SHA と直前に走らせたセッションの名前・今回の作業を始めた時刻（findDecisionNotToWaitForCi を参照）
 * @returns {{ headSha: string, decisionNotToWait: ReturnType<typeof findDecisionNotToWaitForCi> }} リモートのブランチの SHA と、記録にそのまま書く待たない理由（待ってよければ null）
 * @throws {Error} git・gh が失敗したとき
 */
function readHeadShaAndDecisionNotToWait({
  issueNumber,
  branchName,
  workspaceDir,
  previousHeadSha,
  lastSessionName,
  workStartedAt
}) {
  const remoteHeadSha = readRemoteHeadSha({ workspaceDir, branchName })
  const localHeadSha = readLocalHeadSha(workspaceDir)
  const { state, labelNames } = readIssueStatus(issueNumber)
  // マージで消えたブランチを、差分が出ずに閉じた Issue と見分けるためだけに引く。ブランチが残っていれば要らない
  const mergedPullRequest = remoteHeadSha ? null : findMergedPullRequest(branchName)
  return {
    headSha: remoteHeadSha,
    decisionNotToWait: findDecisionNotToWaitForCi({
      state,
      labelNames,
      remoteHeadSha,
      localHeadSha,
      previousHeadSha,
      lastSessionName,
      mergedPullRequest,
      workStartedAt
    })
  }
}

/**
 * push した commit の CI を待ち、落ちていれば `/auto-fix-ci` に直させる。通るか、直させるのをやめるまで戻らない。
 * 結果は record へ書き足す。
 *
 * @param {{ issueNumber: number, branchName: string, workspaceDir: string, headShaBeforeSession: string | null, sessionName: string, workStartedAt: string }} target 対象 Issue の番号・トピックブランチ名・作業している AI 専用 clone・セッションの前のリモートのブランチの SHA（これと同じなら push されなかったとみなす。新しく作ったブランチなら null）・CI を待つ前に走らせたセッションの名前・今回の作業を始めた時刻（ISO 8601）
 * @param {Record<string, unknown>} record 書き足す先の記録
 * @returns {Promise<boolean>} `/auto-fix-ci` を走らせなかったか、すべて正常終了したら true
 * @throws {Error} git・gh・claude を起動できなかった／失敗したとき
 */
async function watchCiAndFix(
  { issueNumber, branchName, workspaceDir, headShaBeforeSession, sessionName, workStartedAt },
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
      workStartedAt,
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
    if (stopSignal.aborted) {
      record.ciOutcome = 'CI を待つ途中で止めました'
      return true
    }

    const nextStep = decideAfterCiRun({
      state: runState.state,
      fixAttemptCount,
      maxFixAttempts: config.ci.maxFixAttempts
    })
    if (nextStep !== 'fix') {
      finishCiWatch({ issueNumber, nextStep, runState, record })
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
    abortSignal: stopSignal
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
 * Issue 1件ぶんの作業を走らせ、途中で落ちても結果を記録する。予定した終わり方以外で終えたら、記録の前に `needs-human-check` を付ける
 * （付けられなくても投げない）。
 *
 * @param {{ record: Record<string, unknown> & { issueNumber: number }, runWork: (record: Record<string, unknown>, workStartedAt: string) => Promise<boolean>, readPullRequestUrl: () => string | null }} params 記録の初期値・作業（受け取った記録へ結果を書き足し、作業を始めた時刻（ISO 8601。記録の `sessionStartedAt` と同じ値）を受け取り、走らせた claude セッションがすべて正常終了したら true を返す）・記録に残す PR の URL を引く関数（作業の後に呼ぶ）
 * @returns {Promise<boolean>} 走らせた claude セッションがすべて正常終了したら true（起動できなかった・打ち切られた・0 以外で終わった・途中で例外が出たら false）
 * @throws {Error} 記録ファイルへ書けなかったとき
 */
async function runWorkAndRecord({ record, runWork, readPullRequestUrl }) {
  const workStartedAt = new Date().toISOString()
  record.sessionStartedAt = workStartedAt
  setInFlightIssueNumber(record.issueNumber)
  let isAllSessionsSucceeded = false
  try {
    isAllSessionsSucceeded = await runWork(record, workStartedAt)
  } catch (error) {
    // 無人実行の画面はセッションの出力で流れるため、スタックを出すと原因の1行が埋もれる（Issue #780）
    record.error = formatErrorMessage(error)
    record.errorStack = formatErrorWithStack(error)
    showError(`#${record.issueNumber} の処理が落ちました: ${collapseToSingleLine(record.error)}`)
  } finally {
    record.pullRequestUrl = readPullRequestUrl()
    record.finishedAt = new Date().toISOString()
    if (shouldMarkAsNeedsHumanCheck(record, isAllSessionsSucceeded)) {
      Object.assign(record, tryMarkAsNeedsHumanCheck(record.issueNumber))
    }
    recordRun(record)
    clearInFlightIssueNumber()
    showRunSummary(record, isAllSessionsSucceeded)
  }
  return isAllSessionsSucceeded
}

/**
 * 着手中へ動かした Issue 1件を監査し、止める理由が無ければ実装させ、CI が通るまで直させる。結果は record へ書き足す。
 *
 * @param {StartedIssue} startedIssue startFirstStartableIssue の結果
 * @param {Record<string, unknown>} record 書き足す先の記録
 * @param {string} workStartedAt 今回の作業を始めた時刻（ISO 8601）
 * @returns {Promise<boolean>} 走らせた claude セッションがすべて正常終了したら true
 * @throws {Error} git・gh・claude を起動できなかった／失敗したとき
 */
async function implementAndWatchCi(startedIssue, record, workStartedAt) {
  const { issue, branchName, workspaceDir } = startedIssue
  const issueDestination = await handOverOrImplement(issue.number, workspaceDir, record)
  if (record.subIssueHandover) showSubIssueHandover(record)
  if (record.reasonNotToImplement) showWarning(`実装へ進みません: ${record.reasonNotToImplement}`)
  // 引き継いだ・見送った回は、走らせたセッションがすべて成功している
  if (issueDestination !== 'implemented') return issueDestination !== 'session-failed'
  // ブランチは着手時にデフォルトブランチから作り直しているので、push されていれば最初の SHA から待ってよい
  return watchCiAndFix(
    {
      issueNumber: issue.number,
      branchName,
      workspaceDir,
      headShaBeforeSession: null,
      sessionName: '/auto-dev',
      workStartedAt
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
    runWork: (record, workStartedAt) => implementAndWatchCi(startedIssue, record, workStartedAt),
    readPullRequestUrl: () => findCreatedPullRequestUrl(branchName, existingPullRequestNumbers)
  })
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

/** @typedef {ReturnType<typeof tryListConflictedOwnPullRequests>[number] & { headShaBeforeSession: string, isAutoMergeEnabled: boolean, issueLock: IssueLock }} ClaimedConflictedPullRequest 衝突を解かせると決めた PR。その Issue のロックは issueLock に載り、解き終えたら呼び出し側が外す */

/**
 * 呼び出し側が読み直した PR の状態と、ここで読み直す Issue の state・ラベルから、衝突を解かせずに飛ばす理由を探す。
 *
 * @param {{ candidate: ReturnType<typeof tryListConflictedOwnPullRequests>[number], pullRequest: ReturnType<typeof readPullRequestStatus> }} params 衝突を解かせる候補と、その PR の読み直した状態
 * @returns {string | null} 解かせない理由（解かせてよければ null）
 * @throws {Error} Issue の state・ラベルを読めなかったとき
 */
function readIssueAndFindReasonNotToResolveConflict({ candidate, pullRequest }) {
  const { issueNumber, lastWaitedHeadSha } = candidate
  return findReasonNotToResolveConflict({
    pullRequest,
    issue: { number: issueNumber, ...readIssueStatus(issueNumber) },
    lastWaitedHeadSha,
    needsHumanCheckLabel: NEEDS_HUMAN_CHECK_LABEL
  })
}

/**
 * 衝突した PR の Issue のロックを取り、PR と Issue を読み直して、まだ解かせてよいかを確かめる。飛ばすときは理由を出す。
 *
 * 解かせてよいときは、取ったロックを PR に載せて返す。飛ばしたときは、次の候補へ進む前にここで外す。
 *
 * @param {ReturnType<typeof tryListConflictedOwnPullRequests>[number]} candidate 衝突を解かせる候補
 * @returns {ClaimedConflictedPullRequest | null} 解かせると決めた PR（飛ばしたら null）
 */
function tryClaimConflictedPullRequest(candidate) {
  const { issueNumber, pullRequestNumber } = candidate
  const subject = `PR #${pullRequestNumber}（#${issueNumber}）の衝突`
  let issueLock = null
  let isClaimed = false
  try {
    const lockAttempt = issueLockKeeper.tryAcquire(issueNumber)
    issueLock = lockAttempt.lock
    if (lockAttempt.skipReason) {
      showConflictSkipReasonOnce({ pullRequestNumber, subject, reason: lockAttempt.skipReason })
      return null
    }
    const pullRequest = readPullRequestStatus(pullRequestNumber)
    const reason = readIssueAndFindReasonNotToResolveConflict({ candidate, pullRequest })
    if (reason !== null) {
      showConflictSkipReasonOnce({ pullRequestNumber, subject, reason })
      return null
    }
    isClaimed = true
    const { headSha, isAutoMergeEnabled } = pullRequest
    return { ...candidate, headShaBeforeSession: headSha, isAutoMergeEnabled, issueLock }
  } catch (error) {
    showWarning(`${subject}を飛ばします: ${formatErrorMessage(error)}`)
    return null
  } finally {
    // 持ったまま飛ばすと、このプロセスが動いている間、他のプロセスもこの Issue を試せない
    if (!isClaimed) issueLockKeeper.release(issueLock)
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
    if (stopSignal.aborted) return null
    const conflictedPullRequest = tryClaimConflictedPullRequest(candidate)
    if (conflictedPullRequest) return conflictedPullRequest
  }
  return null
}

/**
 * 衝突した PR のブランチへ切り替えて `/auto-resolve-conflict` に解かせ、push されたら CI が通るまで直させる。結果は record へ書き足す。
 *
 * @param {{ conflictedPullRequest: ClaimedConflictedPullRequest, workspaceDir: string }} params 解かせると決めた PR と、このプロセスが使う AI 専用 clone
 * @param {Record<string, unknown>} record 書き足す先の記録
 * @param {string} workStartedAt 今回の作業を始めた時刻（ISO 8601）
 * @returns {Promise<boolean>} 走らせた claude セッションがすべて正常終了したら true
 * @throws {Error} git・gh・claude を起動できなかった／失敗したとき
 */
async function resolveConflictAndWatchCi(
  { conflictedPullRequest, workspaceDir },
  record,
  workStartedAt
) {
  const { issueNumber, pullRequestNumber, branchName, headShaBeforeSession, isAutoMergeEnabled } =
    conflictedPullRequest
  // 外さずに解くと、解いた push の CI が通った瞬間、pr-ai-triage が中身を見る前にマージされうる。
  // 外したことを記録に残す。push されずに終わると pr-ai-triage が走らず、外れたまま残るので、人間が記録から気づけるようにする
  if (isAutoMergeEnabled) {
    disableAutoMerge(pullRequestNumber)
    showInfo(
      `PR #${pullRequestNumber} の auto-merge を外しました。解いた後の CI が通ると、pr-ai-triage が中身を見て付け直します`
    )
    record.isAutoMergeDisabled = true
  }
  // リモートの最新ではなく、確かめた commit へ切り替える。確かめた後に入った push の中身を、無人セッションで走らせない
  switchToPullRequestBranch({ workspaceDir, branchName, headSha: headShaBeforeSession })
  ensureDependencies(workspaceDir)
  const resolveStatus = await runAutoResolveConflictSession({
    issueNumber,
    workspaceDir,
    abortSignal: stopSignal
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
      sessionName: '/auto-resolve-conflict',
      workStartedAt
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
    runWork: (record, workStartedAt) =>
      resolveConflictAndWatchCi({ conflictedPullRequest, workspaceDir }, record, workStartedAt),
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
    showWarning(`マージ済み PR の Issue を閉じられませんでした: ${formatErrorMessage(error)}`)
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
  if (stopSignal.aborted) return false
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
  await sleepUnlessStopped(IDLE_BOARD_POLL_INTERVAL_MS)
  return false
}

/** @typedef {{ runWork: () => Promise<boolean>, issueLock: IssueLock }} ClaimedWork 選んだ作業を走らせる関数と、その Issue のロック。走らせ終えたら呼び出し側がロックを外す */

/**
 * 次にする作業を1つ選び、その Issue のロックを取る。衝突した自分の PR を、新しい Issue より先に選ぶ。
 *
 * 選んだ作業の Issue のロックは claimedWork に載せて返す。外すのは呼び出し側で、作業を終えたときに issueLockKeeper.release を呼ぶ。
 *
 * @param {string} workspaceDir このプロセスが使う AI 専用 clone
 * @returns {Promise<{ claimedWork: ClaimedWork | null, idleReason: string | null }>} 選んだ作業（する作業が無いときは null）と、
 *   作業が無いときに待機中のステータス行へ出す理由（作業があるときは null）
 */
async function claimNextWork(workspaceDir) {
  const conflictedPullRequest = await claimFirstConflictedPullRequest()
  if (conflictedPullRequest) {
    return {
      claimedWork: {
        runWork: () => resolveConflictAndRecord({ conflictedPullRequest, workspaceDir }),
        issueLock: conflictedPullRequest.issueLock
      },
      idleReason: null
    }
  }
  try {
    const { startedIssue, idleReason } = await startFirstStartableIssue(workspaceDir)
    if (!startedIssue) return { claimedWork: null, idleReason }
    return {
      claimedWork: {
        runWork: () => implementIssueAndRecord(startedIssue),
        issueLock: startedIssue.issueLock
      },
      idleReason: null
    }
  } catch (error) {
    // 候補を引けなかった回は「着手できる Issue が無い」とは別の理由なので、待機行に書き分ける。
    // 書き分けないと、gh の失敗などで待ち続けている間も「正常に空振りしている」ように見える
    showError(`候補を引けませんでした: ${formatErrorWithStack(error)}`)
    return { claimedWork: null, idleReason: '候補を引けず、次の見直しで再試行' }
  }
}

/**
 * Ctrl+C が来るか、着手できない周が上限を超えるまで、衝突した PR を解かせるか Issue を拾うかを1件ずつ処理する。
 *
 * @param {string} workspaceDir このプロセスが使う AI 専用 clone
 * @returns {Promise<void>}
 * @throws {TechnicalError} claude のセッションが続けて失敗したとき
 * @throws {Error} 記録ファイルへ書けなかったとき
 */
async function processIssuesUntilStopped(workspaceDir) {
  let consecutiveSessionFailureCount = 0
  let idlePollCount = 0
  let isIdleWaitLimitReached = false
  while (!stopSignal.aborted && !isIdleWaitLimitReached) {
    tryCloseIssuesOfMergedPullRequests()
    const { claimedWork, idleReason } = await claimNextWork(workspaceDir)
    if (!claimedWork) {
      idlePollCount += 1
      isIdleWaitLimitReached = await waitUnlessIdleWaitLimitReached(idlePollCount, idleReason)
      continue
    }
    idlePollCount = 0

    let isAllSessionsSucceeded
    try {
      isAllSessionsSucceeded = await claimedWork.runWork()
    } finally {
      issueLockKeeper.release(claimedWork.issueLock)
    }
    // Ctrl+C で止めた回は数えない（冒頭の設計意図）
    if (stopSignal.aborted) break
    consecutiveSessionFailureCount = isAllSessionsSucceeded ? 0 : consecutiveSessionFailureCount + 1
    if (consecutiveSessionFailureCount >= MAX_CONSECUTIVE_SESSION_FAILURES) {
      throw new TechnicalError(
        `claude のセッションが ${consecutiveSessionFailureCount} 回続けて失敗しました。記録の issueCheckExitCode・issueCheckSignal・autoDevExitCode・autoDevSignal・ciFixExitCode・ciFixSignal・conflictResolutionExitCode・conflictResolutionSignal・error を読んで原因を直し、もう一度打ってください`
      )
    }
    await yieldToEventLoop()
  }
}
