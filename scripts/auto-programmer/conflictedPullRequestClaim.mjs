// 責務: 衝突を解かせる PR の候補を、実行記録と gh の open な PR の一覧から引く口を担う。引いた候補を解かせるかは呼び出し側が決める。
//
// 設計意図（WHY）:
// - open な PR の一覧の取得は、実行記録と突き合わせて自分の PR を選ぶ衝突解消専用の取得で、PR 1件・1ブランチ単位の口である
//   pullRequestQuery.mjs に収まらないため、ここに置く。
// - 引けなくても投げず、理由を出して空にする。衝突した PR を探せないだけで周回が止まると、後ろの Issue まで着手されなくなる。
// - 呼び出し側を import しない。呼び出し側からこのモジュールへの一方向にして、循環を作らない。

import { config } from './config.mjs'
import {
  collectOwnPullRequestsByUrl,
  CONFLICT_CHECK_PULL_REQUEST_FIELDS,
  selectConflictedOwnPullRequests
} from './conflictedPullRequest.mjs'
import { readRunRecords } from './runLog.mjs'
import { runJson } from './shell.mjs'
import { showWarning } from './ui.mjs'
import { formatErrorMessage } from './uiFormat.mjs'

// 衝突した PR を探すときに引く open な PR の上限。gh pr list の既定の30件では、人間のレビュー待ちが溜まると取りこぼす
const OPEN_PULL_REQUEST_FETCH_LIMIT = 200

/**
 * このツールが作った open な PR のうち、衝突しているものを PR 番号の小さい順に引く。引けなくても投げず、警告を出して空にする。
 *
 * @returns {ReturnType<typeof listConflictedOwnPullRequests>} 衝突を解かせる候補（PR 番号の小さい順。引けなければ空）
 */
export function tryListConflictedOwnPullRequests() {
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
