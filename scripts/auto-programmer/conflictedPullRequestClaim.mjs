// 責務: 衝突を解かせる PR の候補を、実行記録と gh の open な PR の一覧から引き、Issue のロックを取って解かせてよいかを確かめ、1件を選ぶところまでを担う。選んだ PR の衝突を解かせるのは呼び出し側が行う。
//
// 設計意図（WHY）:
// - open な PR の一覧の取得は、実行記録と突き合わせて自分の PR を選ぶ衝突解消専用の取得で、PR 1件・1ブランチ単位の口である
//   pullRequestQuery.mjs に収まらないため、ここに置く。
// - 引けなくても投げず、理由を出して空にする。衝突した PR を探せないだけで周回が止まると、後ろの Issue まで着手されなくなる。
// - 呼び出し側を import しない。呼び出し側からこのモジュールへの一方向にして、循環を作らない。

import { setImmediate as yieldToEventLoop } from 'node:timers/promises'

import { config } from './config.mjs'
import {
  collectOwnPullRequestsByUrl,
  CONFLICT_CHECK_PULL_REQUEST_FIELDS,
  findReasonNotToResolveConflict,
  selectConflictedOwnPullRequests
} from './conflictedPullRequest.mjs'
import { readIssueStatus } from './issueQuery.mjs'
import { NEEDS_HUMAN_CHECK_LABEL } from './needsHumanCheck.mjs'
import { issueLockKeeper } from './processLocks.mjs'
import { readPullRequestStatus } from './pullRequestQuery.mjs'
import { readRunRecords } from './runLog.mjs'
import { runJson } from './shell.mjs'
import { stopSignal } from './stopSignals.mjs'
import { showInfo, showWarning } from './ui.mjs'
import { formatErrorMessage } from './uiFormat.mjs'

// 衝突した PR を探すときに引く open な PR の上限。gh pr list の既定の30件では、人間のレビュー待ちが溜まると取りこぼす
const OPEN_PULL_REQUEST_FETCH_LIMIT = 200

// 衝突した PR ごとに、最後に出した飛ばす理由（showConflictSkipReasonOnce が同じ行を毎周出さないためのもの）
const shownConflictSkipReasonsByPullRequestNumber = new Map()

/** @typedef {import('./processLocks.mjs').IssueLock} IssueLock */

/** @typedef {ReturnType<typeof tryListConflictedOwnPullRequests>[number] & { headShaBeforeSession: string, isAutoMergeEnabled: boolean, issueLock: IssueLock }} ClaimedConflictedPullRequest 衝突を解かせると決めた PR。その Issue のロックは issueLock に載り、解き終えたら呼び出し側が外す */

/**
 * 衝突している自分の PR を PR 番号の小さい順に試し、最初に解かせると決めた1件を返す。
 *
 * @returns {Promise<ClaimedConflictedPullRequest | null>} 解かせると決めた PR（無い・全部飛ばした・止められたときは null）
 */
export async function claimFirstConflictedPullRequest() {
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
 * このツールが作った open な PR のうち、衝突しているものを PR 番号の小さい順に引く。引けなくても投げず、警告を出して空にする。
 *
 * @returns {ReturnType<typeof listConflictedOwnPullRequests>} 衝突を解かせる候補（PR 番号の小さい順。引けなければ空）
 */
function tryListConflictedOwnPullRequests() {
  try {
    return listConflictedOwnPullRequests()
  } catch (error) {
    showWarning(
      `衝突した PR を探せませんでした。Issue の着手へ進みます: ${formatErrorMessage(error)}`
    )
    return []
  }
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
