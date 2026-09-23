#!/usr/bin/env node
// 責務: ボードの着手待ちのカードから Issue を1件ずつ拾い、AI 専用 clone で実装させ、PR まで到達させる唯一の入口。
//
// 設計意図（WHY）:
// - 拾う・順序を決める・記録するはすべてここで決定論的に行う。AI に任せると、同じ盤面から毎回
//   違う Issue を拾い、何が起きたかを追えなくなる。AI に渡すのは Issue 1件の監査と実装だけ。
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
//   監査の前に `issue:checked` を外し、貼り直されたことを「今回の判定が書き戻された」印にする。

import { setImmediate as yieldToEventLoop, setTimeout as sleep } from 'node:timers/promises'

import { listStartableIssues, markAsStarted } from './board.mjs'
import { buildBranchName } from './branchName.mjs'
import { runAutoDevSession, runIssueCheckSession } from './claudeSession.mjs'
import { config } from './config.mjs'
import { findReasonToSkipImplementation } from './issueCheckVerdict.mjs'
import { ensureDependencies, runPreflight } from './preflight.mjs'
import { recordRun } from './runLog.mjs'
import { runJson, runOrThrow } from './shell.mjs'
import { prepareTopicBranch } from './workspace.mjs'

const MILLISECONDS_PER_MINUTE = 60 * 1000

// 候補が無かったときに、ボードを見直すまで待つ時間
const POLL_INTERVAL_MS = config.pollIntervalMinutes * MILLISECONDS_PER_MINUTE

// /issue-check が判定の中身に関わらず貼るラベル。`.claude/skills/issue-check/SKILL.md` の表記が正
const ISSUE_CHECKED_LABEL = 'issue:checked'

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
 * @param {{ pullRequestUrl: string | null }} record 記録した内容
 * @returns {void}
 */
function printOutcome({ pullRequestUrl }) {
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
 * @returns {Promise<{ issue: { number: number, title: string }, branchName: string, existingPullRequestNumbers: Set<number> } | null>} 着手した Issue（着手できる Issue が無い・全部飛ばした・止められたときは null）
 * @throws {Error} 候補を引けなかったとき
 */
async function startFirstStartableIssue() {
  const issues = listStartableIssues()
  if (issues.length === 0) {
    console.log(
      `着手できる Issue はありません（${config.board.readyStatusName} かつ ${config.targetIssueLabel}、ブロッカーが全部 closed）`
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
 * `/issue-check` を通し、止める理由が無ければ `/auto-dev` を走らせる。結果は record へ書き足す。
 *
 * record を引数で受けるのは、途中で例外が出ても、そこまでの結果を呼び出し側が記録できるようにするため。
 *
 * @param {number} issueNumber 対象 Issue の番号
 * @param {Record<string, unknown>} record 書き足す先の記録
 * @returns {boolean} 走らせた claude セッションがすべて正常終了したら true
 * @throws {Error} claude を起動できなかったとき・Issue のラベルを外せなかった／引き直せなかったとき
 */
function auditThenImplement(issueNumber, record) {
  runOrThrow('gh', [
    'issue',
    'edit',
    String(issueNumber),
    '--repo',
    config.repository,
    '--remove-label',
    ISSUE_CHECKED_LABEL
  ])
  const issueCheckStatus = runIssueCheckSession(issueNumber)
  record.issueCheckExitCode = issueCheckStatus.exitCode
  record.issueCheckSignal = issueCheckStatus.signal
  if (!hasSessionSucceeded(issueCheckStatus)) {
    // 監査の結果が書き戻されたか分からないまま実装へ進むと、止めるべき Issue を実装しうる
    record.skippedReason = '/issue-check のセッションが失敗しました'
    return false
  }

  record.skippedReason = findReasonToSkipImplementation(readIssueStatus(issueNumber))
  if (record.skippedReason) return true

  const autoDevStatus = runAutoDevSession(issueNumber)
  Object.assign(record, autoDevStatus)
  return hasSessionSucceeded(autoDevStatus)
}

/**
 * 着手中へ動かした Issue 1件を監査し、止める理由が無ければ実装させる。途中で落ちても結果を記録する。
 *
 * @param {{ issue: { number: number, title: string }, branchName: string, existingPullRequestNumbers: Set<number> }} startedIssue startFirstStartableIssue の結果
 * @returns {boolean} 走らせた claude セッションがすべて正常終了したら true（起動できなかった・打ち切られた・0 以外で終わった・途中で例外が出たら false）
 * @throws {Error} 記録ファイルへ書けなかったとき
 */
function runSessionAndRecord({ issue, branchName, existingPullRequestNumbers }) {
  const record = { issueNumber: issue.number, issueTitle: issue.title, branchName }
  record.sessionStartedAt = new Date().toISOString()
  let isAllSessionsSucceeded = false
  try {
    isAllSessionsSucceeded = auditThenImplement(issue.number, record)
    if (record.skippedReason) console.log(`実装へ進みません: ${record.skippedReason}`)
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
  console.log(`${POLL_INTERVAL_MS / 1000} 秒後に見直します`)
  try {
    await sleep(POLL_INTERVAL_MS, undefined, { signal: stopController.signal })
  } catch (error) {
    if (!(error instanceof Error && error.name === 'AbortError')) throw error
  }
}

async function main() {
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

    const isAllSessionsSucceeded = runSessionAndRecord(startedIssue)
    consecutiveSessionFailureCount = isAllSessionsSucceeded ? 0 : consecutiveSessionFailureCount + 1
    if (consecutiveSessionFailureCount >= MAX_CONSECUTIVE_SESSION_FAILURES) {
      throw new Error(
        `claude のセッションが ${consecutiveSessionFailureCount} 回続けて失敗しました。記録の issueCheckExitCode・issueCheckSignal・exitCode・signal・error を読んで原因を直し、もう一度打ってください`
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
