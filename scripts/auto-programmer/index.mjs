#!/usr/bin/env node
// 責務: ボードの着手待ちのカードの Issue と、衝突して止まった自分の PR を1件ずつ拾い、AI 専用 clone で CI の通った PR まで到達させる唯一の入口。
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
//   CI を待って直させる処理は watchCiAndFix.mjs、作業を走らせて記録する決まりは runWorkAndRecord.mjs が持つ（衝突の解消と共有する）。
//   ここが決めるのは、Issue の実装でそれらをいつ呼ぶか（implementIssueAndRecord・implementAndWatchCi）である。
// - カードを「レビュー待ち」へは動かさない。PR が Issue に紐づいた時点で、ボードの組み込みワークフロー
//   「Pull request linked to issue」が動かす（Issue #995）。CI の通過を待って動かすと、同じ移動が二重になる。
// - 毎周、Issue を選ぶ前に、自動マージされた PR が閉じ損ねた Issue を閉じる（Issue #744）。起動時の1回だけだと、
//   回っている間にマージされた PR の Issue が閉じず、それを「ブロッカー」に持つ Issue がいつまでも拾われない。
//   閉じられなくても次の Issue は選べるので、失敗しても周回は止めない。
// - 予定した終わり方以外で終えた Issue には `needs-human-check` を付ける（付け方は runWorkAndRecord.mjs）。
//   カードの列だけでは止まった Issue を引けない（Issue #1000）。
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
//   取り合わないよう、衝突を解かせる間も同じ Issue のロックを持つ。解かせる処理は conflictResolution.mjs が持つ。
// - Issue のロックは、取った関数が戻り値（StartedIssue・ClaimedConflictedPullRequest）で持ち主に渡す。作業まで進んだロックは
//   processIssuesUntilStopped の finally が、飛ばした候補のロックは候補を選ぶ側が、次の候補へ進む前に外す。飛ばした候補は
//   processIssuesUntilStopped へ戻らず、選ぶ側のループが次の候補へ進むので、finally 1か所には集められない。持ち主の見えない
//   変数に外す義務を預けると外し忘れが見えないので、変数に控えるのは、シグナルで終わる（finally に届かない）ときにリスナが外す
//   ためだけにする。その控えは issueLockKeeper の中に閉じ、取る・外す口もそこに絞る。
// - ロックの定義（置き場・取り方・外し方・控え）は processLocks.mjs が持つ。ここが決めるのは、周回で Issue の着手を試すときにいつ取り、飛ばしたとき・作業を終えたときにいつ外すかである（衝突した PR の Issue のロックを取り、飛ばすときに外すのは conflictedPullRequestClaim.mjs、シグナルで終わるときに外すのは stopSignals.mjs のリスナ）。
// - 終了シグナルは、受けるたびに実行中の claude セッションへ子孫ごと送る。AbortController は1度しか合図せず、Ctrl+C の後の SIGTERM は
//   届かないので、最初の1つは abort、2つ目以降はイベントで届ける（使い分けは shell.mjs の sendSignalToWatchedChildren に閉じる）。
//   Ctrl+C で止めた回は、セッションが打ち切られて失敗に見えるだけで、claude が壊れた兆候ではないので、連続失敗に数えない。
// - 終了シグナルのリスナと、リスナが中止する stopController・着手中の Issue の番号は、stopSignals.mjs が持つ。ここが決めるのは、リスナを
//   いつ付けるか（main の先頭）、stopSignal をどのセッション・待機に渡し、どこで見て周回を抜けるかである
//   （着手中の番号を控え・外すのは runWorkAndRecord.mjs、CI 待ちに渡すのは watchCiAndFix.mjs、衝突を解かせるセッションへ渡すのは conflictResolution.mjs）。
// - gh の戻り値は、並び順を信じない。記録する PR は番号が最大のものを採る（gh は新しい順に返す）。

import { setImmediate as yieldToEventLoop } from 'node:timers/promises'

import { closeIssuesOfMergedPullRequests } from '../close-issues.mjs'
import { TechnicalError } from '../lib/errors.mjs'
import {
  listStartableIssues,
  markCardAsStarted,
  putOnReadyAssignedToMe,
  readCardStatusName
} from './board.mjs'
import { buildBranchName, validateBranchPrefix } from './branchName.mjs'
import { hasSessionSucceeded, runAutoDevSession, runIssueCheckSession } from './claudeSession.mjs'
import { config } from './config.mjs'
import { claimFirstConflictedPullRequest } from './conflictedPullRequestClaim.mjs'
import { resolveConflictAndRecord } from './conflictResolution.mjs'
import { decideAfterIdlePoll, validateMaxConsecutiveIdleWaits } from './idleWait.mjs'
import { validateSessionModelSettings } from './sessionModel.mjs'
import {
  findSkipImplementationDecision,
  ISSUE_CHECKED_LABEL,
  HUMAN_ONLY_LABELS
} from './issueCheckVerdict.mjs'
import { listSubIssues, readIssueStatus } from './issueQuery.mjs'
import { speakIssueResult } from './issueResultSpeech.mjs'
import { removeNeedsHumanCheckLabel } from './issueWrite.mjs'
import { isSubIssueHandoverEmpty } from './needsHumanCheck.mjs'
import { ensureDependencies, runPreflight } from './preflight.mjs'
import { acquireWorkspaceDir, issueLockKeeper, releaseWorkspaceLock } from './processLocks.mjs'
import { listPullRequests } from './pullRequestQuery.mjs'
import { runWorkAndRecord } from './runWorkAndRecord.mjs'
import { runOrThrow } from './shell.mjs'
import { startSleepGuard } from './sleepGuard.mjs'
import { installStopSignalListeners, sleepUnlessStopped, stopSignal } from './stopSignals.mjs'
import {
  findReasonToSkipForOpenSubIssues,
  selectSubIssuesToPutOnReady
} from './subIssueHandover.mjs'
import { showError, showInfo, showIssueBanner, showStatusLine, showWarning } from './ui.mjs'
import { formatErrorMessage, formatErrorWithStack } from './uiFormat.mjs'
import { watchCiAndFix } from './watchCiAndFix.mjs'
import { prepareTopicBranch, readLocalHeadSha } from './workspace.mjs'

const MILLISECONDS_PER_SECOND = 1000
const MILLISECONDS_PER_MINUTE = 60 * MILLISECONDS_PER_SECOND

const IDLE_BOARD_POLL_INTERVAL_MS = config.pollIntervalMinutes * MILLISECONDS_PER_MINUTE

// 着手できる Issue が無い周に、待機中のステータス行へ出す理由
const NO_STARTABLE_ISSUE_IDLE_REASON = '着手できる Issue なし'

// セッションがこの回数続けて失敗したら止める。claude 側が壊れている（ログイン切れ・利用上限など）と、
// 待たずに次のカードを着手中へ送り、Ready のカードを PR 無しのまま使い切るため
const MAX_CONSECUTIVE_SESSION_FAILURES = 2

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
    readPullRequestUrl: () => findCreatedPullRequestUrl(branchName, existingPullRequestNumbers),
    speakRunOutcome: (runOutcome) =>
      speakIssueResult({ issueNumber: issue.number, issueTitle: issue.title, runOutcome })
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
