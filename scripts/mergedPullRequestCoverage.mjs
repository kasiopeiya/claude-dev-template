// 責務: ローカルブランチが、デフォルトブランチへマージ済みの PR の作業かを判定する。
//   ブランチを消すか・残すかは呼び出し側（prune-merged-branches-and-worktrees.mjs など）が決める。
//   判定の部品の isAncestorCommit も出す。呼び出し側が、判定と同じ基準（終了コード 1 だけを「祖先でない」とする）で祖先関係を確かめるため。
//
// 設計意図（WHY）:
// - 掃除スクリプトの外からも使えるよう、独立したモジュールにして scripts/ 直下に置く。共有するものは scripts/ 直下に置き、
//   auto-programmer などがそこを import する向きに揃える（逆向きの import は依存の逆流になる）。

import { runCommand } from './runCommand.mjs'

const LOCAL_BRANCH_REF_PREFIX = 'refs/heads/'

/**
 * ローカルブランチが、そのブランチ名から出てデフォルトブランチへマージされた PR の作業かを確かめる。
 * 先端が PR の先端と同じかその祖先で、かつマージ直前のデフォルトブランチに含まれていなければ、その PR の作業とみなす。
 *
 * @param {{ originUrl: string, defaultBranchName: string, branch: string }} params
 *   originUrl: origin の URL / defaultBranchName: PR のマージ先 / branch: 確かめるブランチ名
 * @returns {boolean} 当てはまるマージ済み PR があれば true。PR が無い・マージされていない・PR の作業でなければ false
 * @throws {TechnicalError} gh が失敗したとき・PR のコミットが手元に無く判定できなかったとき
 */
export function isCoveredByMergedPullRequest({ originUrl, defaultBranchName, branch }) {
  const mergedPullRequests = JSON.parse(
    runCommand('gh', [
      'pr',
      'list',
      '--repo',
      originUrl,
      '--head',
      branch,
      '--base',
      defaultBranchName,
      '--state',
      'merged',
      '--json',
      'headRefOid,mergeCommit'
    ])
  )
  // 作ったばかりのブランチも先端が origin/<デフォルトブランチ> から辿れるので、git の履歴だけではマージ済みと見分けられない。
  // PR はブランチ名で引けるが、名前だけで照合すると、マージ済み PR と同じ名前で作り直したブランチまで消す。
  // PR の先端と同じコミットに限らないのは、PR の先端がローカルより先へ進んでいることが多いため（別の clone で直した・取り込んだ）
  const localTip = `${LOCAL_BRANCH_REF_PREFIX}${branch}`
  return mergedPullRequests.some(
    ({ headRefOid, mergeCommit }) =>
      isAncestorCommit({ ancestor: localTip, descendant: headRefOid }) &&
      // マージ直前のデフォルトブランチに含まれる先端は、PR の作業ではなく古いデフォルトブランチから作り直したもの
      !isAncestorCommit({ ancestor: localTip, descendant: `${mergeCommit.oid}^1` })
  )
}

/**
 * `ancestor` が `descendant` と同じコミットか、その祖先かを確かめる。
 *
 * @param {{ ancestor: string, descendant: string }} params ancestor: 祖先と見込むコミット / descendant: 子孫と見込むコミット
 * @returns {boolean} 同じか祖先なら true
 * @throws {TechnicalError} どちらかのコミットが手元に無いなど、判定できなかったとき
 */
export function isAncestorCommit({ ancestor, descendant }) {
  try {
    runCommand('git', ['merge-base', '--is-ancestor', ancestor, descendant])
    return true
  } catch (error) {
    // 終了コード 1 だけが「祖先でない」。それ以外（コミットが手元に無いなど）は判定の失敗なので投げる
    if (error.cause?.status === 1) return false
    throw error
  }
}
