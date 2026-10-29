// 責務: push した commit の CI の run が終わるまで待ち、落ちていれば `/auto-fix-ci` に直させる。通るか、直させるのをやめるまで戻らない。
//
// 設計意図（WHY）:
// - Issue の実装と、衝突を解かせた後の両方が同じ待ち方をするので、入口の index.mjs にも conflictResolution.mjs にも置かず、
//   両方が import する下位のモジュールにする。呼び出し側を import しない。呼び出し側からこのモジュールへの一方向にして、循環を作らない。
// - 待ち時間の上限・直させる回数の上限・待つ間隔は config.mjs が持つ。ここは、いつ待たずに戻り、いつ直させ、いつ人間へ回すかの順序を持つ。
//   run の状態の読み方は ciRun.mjs、待たない理由の判定は ciWaitDecision.mjs が持ち、ここは gh・git の呼び出しとそれらをつなぐ。

import { hasSessionSucceeded, runAutoFixCiSession } from './claudeSession.mjs'
import {
  buildHandOverComment,
  decideAfterCiRun,
  describeCiOutcome,
  readCiRunState
} from './ciRun.mjs'
import { listCiRuns, tryListCiRuns } from './ciRunQuery.mjs'
import { findDecisionNotToWaitForCi } from './ciWaitDecision.mjs'
import { config } from './config.mjs'
import { readIssueStatus } from './issueQuery.mjs'
import { commentOnIssue } from './issueWrite.mjs'
import { findMergedPullRequest } from './pullRequestQuery.mjs'
import { runOrThrow } from './shell.mjs'
import { sleepUnlessStopped, stopSignal } from './stopSignals.mjs'
import { createThrottledStatusLine, showInfo, showWarning } from './ui.mjs'
import { formatElapsedTime } from './uiFormat.mjs'
import { readLocalHeadSha } from './workspace.mjs'

const MILLISECONDS_PER_SECOND = 1000
const MILLISECONDS_PER_MINUTE = 60 * MILLISECONDS_PER_SECOND

const CI_POLL_INTERVAL_MS = config.ci.pollIntervalSeconds * MILLISECONDS_PER_SECOND
const CI_RUN_WAIT_LIMIT_MS = config.ci.runWaitLimitMinutes * MILLISECONDS_PER_MINUTE

// 非TTY で CI 待ちの経過を追記する間隔。CI_POLL_INTERVAL_MS のまま追記すると、
// 上限（runWaitLimitMinutes）いっぱい待つ実行で数十行に膨らむ
const CI_WAIT_PROGRESS_APPEND_INTERVAL_MS = 5 * MILLISECONDS_PER_MINUTE

/**
 * push した commit の CI を待ち、落ちていれば `/auto-fix-ci` に直させる。通るか、直させるのをやめるまで戻らない。
 * 結果は record へ書き足す。
 *
 * @param {{ issueNumber: number, branchName: string, workspaceDir: string, headShaBeforeSession: string | null, sessionName: string, workStartedAt: string }} target 対象 Issue の番号・トピックブランチ名・作業している AI 専用 clone・セッションの前のリモートのブランチの SHA（これと同じなら push されなかったとみなす。新しく作ったブランチなら null）・CI を待つ前に走らせたセッションの名前・今回の作業を始めた時刻（ISO 8601）
 * @param {Record<string, unknown>} record 書き足す先の記録
 * @returns {Promise<boolean>} `/auto-fix-ci` を走らせなかったか、すべて正常終了したら true
 * @throws {Error} git・gh・claude を起動できなかった／失敗したとき
 */
export async function watchCiAndFix(
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
