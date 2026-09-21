#!/usr/bin/env node
// 責務: ボードの着手待ちのカードから Issue を1件ずつ拾い、AI 専用 clone で実装させ、PR まで到達させる唯一の入口。
//
// 設計意図（WHY）:
// - 拾う・順序を決める・記録するはすべてここで決定論的に行う。AI に任せると、同じ盤面から毎回
//   違う Issue を拾い、何が起きたかを追えなくなる。AI に渡すのは Issue 1件の実装だけ。
// - 人間が止めるまで終了しない。候補が尽きたら待って見に行く。自分から終了すると、人間が
//   Issue の数だけ打ち直すことになる（Issue #481）。例外は claude のセッションが続けて失敗したときで、
//   このときは続けるほどカードを空振りで着手中へ送るので止める。
// - 着手前に落ちた Issue は飛ばして次の候補へ進む。カードは着手待ちに残るので、原因を直せば
//   次の巡回で拾われる。飛ばさずに止まると、先頭の1件が詰まっただけで後ろの全件が止まる。
// - 落ちうるローカルの準備（clone の巻き戻し・依存）をすべて済ませてから、カードを「着手中」へ動かす。
//   動かした後は着手待ちへ戻さないので、次の巡回が同じ Issue をもう一度拾うことはない。
// - 着手中へ動かした後は、何が起きても記録を1行残す。無人で走るので、記録が唯一の痕跡になる。

import { setImmediate as yieldToEventLoop, setTimeout as sleep } from 'node:timers/promises'

import { listStartableIssues, markAsStarted } from './board.mjs'
import { buildBranchName } from './branchName.mjs'
import { runAutoDevSession } from './claudeSession.mjs'
import { config } from './config.mjs'
import { ensureDependencies, runPreflight } from './preflight.mjs'
import { recordRun } from './runLog.mjs'
import { runJson } from './shell.mjs'
import { prepareTopicBranch } from './workspace.mjs'

// 候補が無かったときに、ボードを見直すまで待つ時間
const POLL_INTERVAL_MS = 60 * 1000

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
 * 着手中へ動かした Issue 1件を実装させる。途中で落ちても結果を記録する。
 *
 * @param {{ issue: { number: number, title: string }, branchName: string, existingPullRequestNumbers: Set<number> }} startedIssue startFirstStartableIssue の結果
 * @returns {boolean} claude セッションが正常終了したら true（起動できなかった・打ち切られた・0 以外で終わったら false）
 * @throws {Error} 記録ファイルへ書けなかったとき
 */
function runSessionAndRecord({ issue, branchName, existingPullRequestNumbers }) {
  const record = { issueNumber: issue.number, issueTitle: issue.title, branchName }
  record.sessionStartedAt = new Date().toISOString()
  try {
    Object.assign(record, runAutoDevSession(issue.number))
  } catch (error) {
    record.error = formatError(error)
    console.error(formatError(error, { withStack: true }))
  } finally {
    record.pullRequestUrl = findCreatedPullRequestUrl(branchName, existingPullRequestNumbers)
    record.finishedAt = new Date().toISOString()
    recordRun(record)
    printOutcome(record)
  }
  return record.exitCode === 0 && record.signal === null
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

    const isSessionSucceeded = runSessionAndRecord(startedIssue)
    consecutiveSessionFailureCount = isSessionSucceeded ? 0 : consecutiveSessionFailureCount + 1
    if (consecutiveSessionFailureCount >= MAX_CONSECUTIVE_SESSION_FAILURES) {
      throw new Error(
        `claude のセッションが ${consecutiveSessionFailureCount} 回続けて失敗しました。記録の exitCode・signal・error を読んで原因を直し、もう一度打ってください`
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
