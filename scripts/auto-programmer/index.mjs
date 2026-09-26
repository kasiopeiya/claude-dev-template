#!/usr/bin/env node
// 責務: ボードの着手待ちのカードから Issue を1件ずつ拾い、AI 専用 clone で実装させ、CI の通った PR まで到達させる唯一の入口。
//
// 設計意図（WHY）:
// - 拾う・順序を決める・記録するはすべてここで決定論的に行う。AI に任せると、同じ盤面から毎回
//   違う Issue を拾い、何が起きたかを追えなくなる。AI に渡すのは Issue 1件の監査・実装・CI の修正だけ。
// - 人間が止めるまで終了しない。候補が尽きたら待って見に行く。自分から終了すると、人間が
//   Issue の数だけ打ち直すことになる（Issue #481）。例外は claude のセッションが続けて失敗したときで、
//   このときは続けるほどカードを空振りで着手中へ送るので止める。
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
// - PR を作った後は、CI の結果が出るまで次の Issue へ進まない。落ちていれば `/auto-fix-ci` を
//   別プロセスで起こして直させ、上限まで直させても落ちていれば人間へ回す。待たずに次へ進むと、落ちた PR が
//   誰にも直されずに残る。CI が落ちたこと自体はセッションの失敗に数えない（claude が壊れている兆候ではない）。
// - CI が通ったときだけカードを「レビュー待ち」へ動かす。人間がレビュー待ちの列だけを見ればよい状態を保つ。
//   動かせなくても例外にせず記録に残す。PR はできているので、ボードの不調で次の Issue を止める理由が無い。

import { setImmediate as yieldToEventLoop, setTimeout as sleep } from 'node:timers/promises'

import { listStartableIssues, markAsInReview, markAsStarted } from './board.mjs'
import { buildBranchName } from './branchName.mjs'
import { runAutoDevSession, runAutoFixCiSession, runIssueCheckSession } from './claudeSession.mjs'
import { config } from './config.mjs'
import { findReasonToSkipImplementation, ISSUE_CHECKED_LABEL } from './issueCheckVerdict.mjs'
import { decideAfterCiRun, readCiRunState } from './ciRun.mjs'
import { ensureDependencies, runPreflight } from './preflight.mjs'
import { recordRun } from './runLog.mjs'
import { runJson, runOrThrow } from './shell.mjs'
import { startSleepGuard } from './sleepGuard.mjs'
import { prepareTopicBranch } from './workspace.mjs'

const MILLISECONDS_PER_SECOND = 1000
const MILLISECONDS_PER_MINUTE = 60 * MILLISECONDS_PER_SECOND

// 候補が無かったときに、ボードを見直すまで待つ時間
const POLL_INTERVAL_MS = config.pollIntervalMinutes * MILLISECONDS_PER_MINUTE

const CI_POLL_INTERVAL_MS = config.ci.pollIntervalSeconds * MILLISECONDS_PER_SECOND
const CI_RUN_WAIT_LIMIT_MS = config.ci.runWaitLimitMinutes * MILLISECONDS_PER_MINUTE

// /auto-dev・/auto-fix-ci が離脱するときに貼るラベル。両 Skill の SKILL.md（離脱手順）の表記と一字一句合わせる
const NEEDS_CLEAN_SESSION_LABEL = 'issue:needs-clean-session'

// セッションがこの回数続けて失敗したら止める。claude 側が壊れている（ログイン切れ・利用上限など）と、
// 待たずに次のカードを着手中へ送り、Ready のカードを PR 無しのまま使い切るため
const MAX_CONSECUTIVE_SESSION_FAILURES = 2

// Ctrl+C を「実行中の1件を記録してから止める」にする。リスナが無いと node はその場で終了し、記録が残らない
const stopController = new AbortController()
process.on('SIGINT', () => stopController.abort())

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
    console.error(`PR の有無を確かめられませんでした: ${formatError(error)}`)
    return null
  }
}

/**
 * 実行結果を1行で表示する。
 *
 * @param {{ pullRequestUrl: string | null, ciOutcome?: string }} record 記録した内容
 * @returns {void}
 */
function printOutcome({ pullRequestUrl, ciOutcome }) {
  if (ciOutcome) console.log(`CI: ${ciOutcome}`)
  if (pullRequestUrl === null) console.log('PR の有無は GitHub で確かめてください')
  else console.log(pullRequestUrl ? `PR: ${pullRequestUrl}` : 'PR は作られませんでした')
  console.log(`記録: ${config.runLogPath}`)
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
  console.log(`ブランチ: ${branchName}`)

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
 * 着手前に落ちた Issue は理由を出して飛ばす。
 *
 * @returns {Promise<{ issue: { itemId: string, number: number, title: string }, branchName: string, existingPullRequestNumbers: Set<number> } | null>} 着手した Issue（着手できる Issue が無い・全部飛ばした・止められたときは null）
 * @throws {Error} 候補を引けなかったとき
 */
async function startFirstStartableIssue() {
  const issues = listStartableIssues()
  if (issues.length === 0) {
    console.log(
      `着手できる Issue はありません（${config.board.readyStatusName} かつ ${config.targetIssueLabel}、自分が担当者、ブロッカーが全部 closed）`
    )
    return null
  }

  for (const issue of issues) {
    // 同期処理の合間にイベントループを回し、Ctrl+C を受け取る
    await yieldToEventLoop()
    if (stopController.signal.aborted) return null

    console.log(`#${issue.number} ${issue.title}`)
    try {
      return { issue, ...startIssue(issue) }
    } catch (error) {
      console.error(`#${issue.number} を飛ばします: ${formatError(error)}`)
    }
  }
  console.log(`着手できる Issue ${issues.length} 件をすべて飛ばしました`)
  return null
}

/**
 * `issue:checked` が無ければ `/issue-check` を通し、止める理由が無ければ `/auto-dev` を走らせる。結果は record へ書き足す。
 *
 * record を引数で受けるのは、途中で例外が出ても、そこまでの結果を呼び出し側が記録できるようにするため。
 *
 * @param {number} issueNumber 対象 Issue の番号
 * @param {Record<string, unknown>} record 書き足す先の記録
 * @returns {boolean} 走らせた claude セッションがすべて正常終了したら true
 * @throws {Error} claude を起動できなかったとき・Issue のラベルを外せなかった／引き直せなかったとき
 */
function auditThenImplement(issueNumber, record) {
  record.issueCheckSkipped = readIssueStatus(issueNumber).labelNames.includes(ISSUE_CHECKED_LABEL)
  if (record.issueCheckSkipped) {
    console.log(`${ISSUE_CHECKED_LABEL} が付いているので /issue-check を飛ばします`)
  } else {
    const issueCheckStatus = runIssueCheckSession(issueNumber)
    record.issueCheckExitCode = issueCheckStatus.exitCode
    record.issueCheckSignal = issueCheckStatus.signal
    if (!hasSessionSucceeded(issueCheckStatus)) {
      // 監査の結果が書き戻されたか分からないまま実装へ進むと、止めるべき Issue を実装しうる
      record.skippedReason = '/issue-check のセッションが失敗しました'
      return false
    }
  }

  record.skippedReason = findReasonToSkipImplementation(readIssueStatus(issueNumber))
  if (record.skippedReason) return true

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
  const autoDevStatus = runAutoDevSession(issueNumber)
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
 * commit の CI の run が終わるまで待つ。待ち時間の上限を使い切るか、Ctrl+C が来たら、その時点の状態で戻る。
 * run を引けなかったときは、待ち時間の上限までは引き直す。
 *
 * @param {string} headSha 待つ commit の SHA
 * @returns {Promise<ReturnType<typeof readCiRunState>>} run の状態（終わらなかったときは pending）
 * @throws {Error} 上限まで引き直しても gh が失敗したとき
 */
async function waitForCiRun(headSha) {
  const deadline = Date.now() + CI_RUN_WAIT_LIMIT_MS
  for (;;) {
    const isLastTry = Date.now() >= deadline || stopController.signal.aborted
    let runs
    try {
      runs = listCiRuns(headSha)
    } catch (error) {
      // 待つ時間が長いほど瞬断や GitHub の一時障害に当たりやすい。1回の失敗でやめると、落ちた PR が誰にも直されずに残る
      if (isLastTry) throw error
      console.error(`CI の run を引けませんでした。引き直します: ${formatError(error)}`)
      await sleepUnlessStopped(CI_POLL_INTERVAL_MS)
      continue
    }
    const runState = readCiRunState(runs, headSha)
    if (runState.state !== 'pending' || isLastTry) return runState
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

    console.log(`CI を待ちます: ${config.ci.workflowFile} @ ${headSha.slice(0, 7)}`)
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
      return true
    }

    fixAttemptCount += 1
    record.ciFixAttemptCount = fixAttemptCount
    console.log(
      `CI が落ちました。/auto-fix-ci に直させます（${fixAttemptCount} 回目）: ${runState.url}`
    )
    const fixStatus = runAutoFixCiSession({ issueNumber: issue.number, runId: runState.runId })
    record.ciFixExitCode = fixStatus.exitCode
    record.ciFixSignal = fixStatus.signal
    if (!hasSessionSucceeded(fixStatus)) {
      record.ciOutcome = '/auto-fix-ci のセッションが失敗しました'
      return false
    }
  }
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
    const isImplemented = auditThenImplement(issue.number, record)
    if (record.skippedReason) console.log(`実装へ進みません: ${record.skippedReason}`)
    const shouldWatchCi = isImplemented && !record.skippedReason
    isAllSessionsSucceeded = shouldWatchCi
      ? await watchCiAndFix(issue, branchName, record)
      : isImplemented
  } catch (error) {
    record.error = formatError(error)
    console.error(formatError(error, { withStack: true }))
  } finally {
    record.pullRequestUrl = findCreatedPullRequestUrl(branchName, existingPullRequestNumbers)
    record.finishedAt = new Date().toISOString()
    recordRun(record)
    printOutcome(record)
  }
  return isAllSessionsSucceeded
}

/**
 * ボードを見直すまで待つ。Ctrl+C が来たら待たずに戻る。
 *
 * @returns {Promise<void>}
 */
async function waitForNextPoll() {
  if (stopController.signal.aborted) return
  console.log(`${POLL_INTERVAL_MS / MILLISECONDS_PER_SECOND} 秒後に見直します`)
  await sleepUnlessStopped(POLL_INTERVAL_MS)
}

async function main() {
  // OS のアイドルスリープで sessionTimeoutMinutes の壁時計タイムアウトが実際の経過時間より早く
  // 効いてしまう（Issue #651）のを防ぐ。index.mjs の生存期間全体に掛かるよう、ここで1回だけ呼ぶ
  startSleepGuard()
  runPreflight()

  let consecutiveSessionFailureCount = 0
  while (!stopController.signal.aborted) {
    let startedIssue
    try {
      startedIssue = await startFirstStartableIssue()
    } catch (error) {
      console.error(`候補を引けませんでした: ${formatError(error, { withStack: true })}`)
    }
    if (!startedIssue) {
      await waitForNextPoll()
      continue
    }

    const isAllSessionsSucceeded = await runSessionAndRecord(startedIssue)
    consecutiveSessionFailureCount = isAllSessionsSucceeded ? 0 : consecutiveSessionFailureCount + 1
    if (consecutiveSessionFailureCount >= MAX_CONSECUTIVE_SESSION_FAILURES) {
      throw new Error(
        `claude のセッションが ${consecutiveSessionFailureCount} 回続けて失敗しました。記録の issueCheckExitCode・issueCheckSignal・autoDevExitCode・autoDevSignal・ciFixExitCode・ciFixSignal・error を読んで原因を直し、もう一度打ってください`
      )
    }
    await yieldToEventLoop()
  }
  console.log('止めました')
}

try {
  await main()
} catch (error) {
  console.error(formatError(error, { withStack: true }))
  process.exitCode = 1
}
