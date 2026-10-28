// 責務: PR を gh で読み書きする口を担う。どの PR をいつ読むか・読んだ結果で何をするかは呼び出し側が決める。
//
// 設計意図（WHY）:
// - gh の引数と戻り値の読み方を、PR 1件・1ブランチ単位の口としてここに置く。直すたびに、周回・ロック・衝突解消の混ざった
//   index.mjs を開かずに済む。リポジトリ全体の open な PR の一覧の取得は、実行記録と突き合わせて自分の PR を選ぶ衝突解消専用の取得で、
//   1件・1ブランチ単位の口に収まらないため conflictedPullRequestClaim.mjs にある。
// - 中身を判断せず、gh が返した値の形だけを整える。マージ済みの PR の番号と時刻のように、読めない値を安全側へ倒すと
//   記録が嘘になるものは、倒さず投げる。
// - 画面への表示は持たない。表示する文面は、呼び出された場面で決まるため、呼び出し側が持つ。
// - 呼び出し側を import しない。呼び出し側からこのモジュールへの一方向にして、循環を作らない。

import { TechnicalError } from '../lib/errors.mjs'
import { config } from './config.mjs'
import { runJson, runOrThrow } from './shell.mjs'

/**
 * ブランチに紐づく PR を、閉じたものも含めて一覧で引く。
 *
 * @param {string} branchName トピックブランチ名
 * @returns {{ number: number, url: string }[]} PR の番号と URL
 * @throws {Error} gh が失敗したとき
 */
export function listPullRequests(branchName) {
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
 * ブランチを head とするマージ済みの PR の番号とマージ時刻を引く。
 *
 * @param {string} branchName トピックブランチ名
 * @returns {{ number: number, mergedAt: string } | null} マージ済みの PR の番号とマージ時刻（ISO 8601。無ければ null）
 * @throws {TechnicalError} gh が返した PR の番号かマージ時刻を読めないとき
 * @throws {Error} gh が失敗したとき
 */
export function findMergedPullRequest(branchName) {
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
    'number,mergedAt'
  ])
  if (mergedPullRequest === undefined) return null
  // 時刻を読めないまま渡すと「今回の作業の前のマージ」と取り違え、PR を出した Issue を差分なしと記録して通知も出ない
  if (
    !Number.isInteger(mergedPullRequest.number) ||
    Number.isNaN(Date.parse(mergedPullRequest.mergedAt))
  ) {
    throw new TechnicalError(
      `マージ済みの PR の番号かマージ時刻を読めません: ${JSON.stringify(mergedPullRequest)}`
    )
  }
  return mergedPullRequest
}

/**
 * PR の state・mergeable・head の SHA と、auto-merge が有効かを引き直す。
 *
 * @param {number} pullRequestNumber PR の番号
 * @returns {{ state: string, mergeable: string, headSha: string, isAutoMergeEnabled: boolean }} state（'OPEN' など）・mergeable（'CONFLICTING' など）・head の SHA・auto-merge が有効か
 * @throws {Error} gh が失敗したとき
 */
export function readPullRequestStatus(pullRequestNumber) {
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
 * PR の auto-merge を外す。
 *
 * @param {number} pullRequestNumber PR の番号
 * @returns {void}
 * @throws {Error} gh が失敗したとき
 */
export function disableAutoMerge(pullRequestNumber) {
  runOrThrow('gh', [
    'pr',
    'merge',
    String(pullRequestNumber),
    '--repo',
    config.repository,
    '--disable-auto'
  ])
}
