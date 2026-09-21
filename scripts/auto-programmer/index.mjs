#!/usr/bin/env node
// 責務: ボードの着手待ちのカードから Issue を1件拾い、AI 専用 clone で実装させ、PR まで到達させる唯一の入口。
//
// 設計意図（WHY）:
// - 拾う・順序を決める・記録するはすべてここで決定論的に行う。AI に任せると、同じ盤面から毎回
//   違う Issue を拾い、何が起きたかを追えなくなる。AI に渡すのは Issue 1件の実装だけ。
// - 1件処理したら終了する。繰り返しは、手で打つのが面倒になってから足す（Issue #480）。
// - 落ちうるローカルの準備（clone の巻き戻し・依存）をすべて済ませてから、カードを「着手中」へ動かす。
//   動かした後は着手待ちへ戻さないので、次の実行が同じ Issue をもう一度拾うことはない。
// - 着手中へ動かした後は、何が起きても記録を1行残す。無人で走るので、記録が唯一の痕跡になる。

import { findNextStartableIssue, markAsStarted } from './board.mjs'
import { buildBranchName } from './branchName.mjs'
import { runAutoDevSession } from './claudeSession.mjs'
import { config } from './config.mjs'
import { ensureDependencies, runPreflight } from './preflight.mjs'
import { recordRun } from './runLog.mjs'
import { runJson } from './shell.mjs'
import { prepareTopicBranch } from './workspace.mjs'

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
 * @param {Set<number>} existingNumbers セッション前からあった PR の番号
 * @returns {string | null} 作られた PR の URL（作られていなければ空文字、確かめられなければ null）
 */
function findCreatedPullRequestUrl(branchName, existingNumbers) {
  try {
    const created = listPullRequests(branchName).filter(
      ({ number }) => !existingNumbers.has(number)
    )
    return created.length > 0 ? created[created.length - 1].url : ''
  } catch (error) {
    console.error(`PR の有無を確かめられませんでした: ${error.message}`)
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
 * カードを着手中へ動かし、Issue 1件を実装させる。途中で落ちても結果を記録する。
 *
 * @param {{ itemId: string, number: number, title: string }} issue 対象 Issue
 * @param {string} branchName 作業したトピックブランチ名
 * @returns {boolean} claude セッションが正常終了したら true
 * @throws {Error} 着手中へ動かしてからの処理が落ちたとき（記録は残したうえで投げ直す）
 */
function runSessionAndRecord(issue, branchName) {
  const existingNumbers = new Set(listPullRequests(branchName).map(({ number }) => number))
  markAsStarted(issue.itemId)

  const record = { issueNumber: issue.number, issueTitle: issue.title, branchName }
  record.sessionStartedAt = new Date().toISOString()
  try {
    Object.assign(record, runAutoDevSession(issue.number))
    return record.exitCode === 0
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    record.pullRequestUrl = findCreatedPullRequestUrl(branchName, existingNumbers)
    record.finishedAt = new Date().toISOString()
    recordRun(record)
    printOutcome(record)
  }
}

function main() {
  runPreflight()

  const issue = findNextStartableIssue()
  if (!issue) {
    console.log(
      `着手できる Issue はありません（${config.board.readyStatusName} かつ ${config.targetIssueLabel}）`
    )
    return
  }

  const branchName = buildBranchName({ issueNumber: issue.number, labelNames: issue.labelNames })
  console.log(`#${issue.number} ${issue.title}`)
  console.log(`ブランチ: ${branchName}`)

  prepareTopicBranch(branchName)
  ensureDependencies()
  process.exitCode = runSessionAndRecord(issue, branchName) ? 0 : 1
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.stack : error)
  process.exitCode = 1
}
