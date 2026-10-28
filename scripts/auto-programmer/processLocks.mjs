// 責務: このプロセスが持つ2種類のロック（AI 専用 clone の番号ロックと、Issue ごとのロック）の置き場・取り方・外し方と、シグナルのリスナが外すための控えを担う。
//   いつ取り、いつ外すかは呼び出し側が決める（Issue の着手を試すときに取り、飛ばしたとき・作業を終えたときに外すのは index.mjs、衝突した PR の Issue のロックを取る・飛ばしたときに外すのは conflictedPullRequestClaim.mjs、シグナルで終わるときに外すのは stopSignals.mjs）。
//
// 設計意図（WHY）:
// - 2種類を1つのモジュールに置くのは、置き場（LOCK_DIRECTORY）と、外せなくても投げない外し方（tryReleaseLockFile）を共有し、
//   控えの持ち方だけが違うため。分けると、共有する2つを3つ目のモジュールへ出すことになる。
// - ロックのファイルの取り方・外し方そのもの（PID・死んだロックの取り直し）は pidLockFile.mjs に任せ、ここでは持たない。
//   ここが持つのは、どこに置くか・どのロックを控えるか・外せなかったときの扱いだけ。
// - 控え（workspaceLock・issueLockKeeper の heldLock）を書き換えるのは、このモジュールの外す口だけにする。外から外すと、
//   ファイルは消えても控えが残る（Issue のロックでは次に取るたびに投げる。理由は createIssueLockKeeper）。
// - 呼び出し側を import しない。呼び出し側からこのモジュールへの一方向にして、循環を作らない。

import { basename, dirname, join } from 'node:path'

import { TechnicalError } from '../lib/errors.mjs'
import { config } from './config.mjs'
import {
  acquireLowestFreeNumberedLockFile,
  releaseLockFile,
  tryAcquireNamedLockFile
} from './pidLockFile.mjs'
import { showInfo, showWarning } from './ui.mjs'
import { formatErrorMessage } from './uiFormat.mjs'

/** @typedef {Parameters<typeof releaseLockFile>[0]} IssueLock 取った Issue のロック。取った関数が戻り値で持ち主に渡し、持ち主が issueLockKeeper.release で外す */

// AI 専用 clone の番号ロックと、Issue ごとのロックの置き場。config.mjs はテンプレート同期の対象外で、同期した利用先では古い形のまま
// 動くので、キーを足さずに既存の workspaceDir から導く。置き場は clone の親（AUTO_PROGRAMMER_HOME）の下で、clone の名前ごとに分ける
const LOCK_DIRECTORY = join(dirname(config.workspaceDir), 'locks', basename(config.workspaceDir))

// このプロセスが取った AI 専用 clone の番号ロック（取る前と外した後は null）。シグナルで終わると index.mjs の main の finally に
// 届かないので、stopSignals.mjs のシグナルのリスナも releaseWorkspaceLock で外す
let workspaceLock = null

// Issue のロックを取る・外す口。シグナルで終わると外す持ち主に届かないので、stopSignals.mjs のリスナが releaseHeld で外す（持ち主は index.mjs 冒頭の設計意図）
export const issueLockKeeper = createIssueLockKeeper()

/**
 * 一番小さい空き番号の AI 専用 clone をロックで取り、その clone のパスを返す。1番は config.workspaceDir をそのまま、
 * 2番以降はその後ろに `-<番号>` を付けたパスにする。取ったロックは releaseWorkspaceLock で外す。
 *
 * @returns {string} このプロセスが使う AI 専用 clone（まだ無ければ preflight が作る）
 * @throws {Error} ロックファイルを読めなかった・作れなかった・消せなかったとき
 */
export function acquireWorkspaceDir() {
  const { lockNumber, lock } = acquireLowestFreeNumberedLockFile({
    lockDirectory: LOCK_DIRECTORY,
    lockFileNamePrefix: 'workspace'
  })
  workspaceLock = lock
  const workspaceDir =
    lockNumber === 1 ? config.workspaceDir : `${config.workspaceDir}-${lockNumber}`
  showInfo(`AI 専用 clone の ${lockNumber} 番を使います: ${workspaceDir}`)
  return workspaceDir
}

/**
 * 取った AI 専用 clone の番号ロックを外す。取っていなければ何もしない。外せなくても投げない。
 *
 * @returns {void}
 */
export function releaseWorkspaceLock() {
  if (workspaceLock === null) return
  tryReleaseLockFile(workspaceLock)
  workspaceLock = null
}

/**
 * Issue のロックを取る・外す口と、シグナルのリスナが外すためのロックの控えを1つにまとめる。控えに触れられるのはこの中だけ。
 *
 * 外す口を release に絞るのは、tryReleaseLockFile を直に呼ぶと、ファイルは消えても控えが残り、次に取るたびに投げて全候補を飛ばし続けるため。
 *
 * @returns {{ tryAcquire: (issueNumber: number) => { lock: IssueLock, skipReason: null } | { lock: null, skipReason: string }, release: (lock: IssueLock | null) => void, releaseHeld: () => void }} 取る口（取れたロックは戻り値の持ち主が外す）・外す口（取れなかったときの null を渡してよい。外せなくても投げない）・持っているロックを外す口（シグナルのリスナ用）
 */
function createIssueLockKeeper() {
  let heldLock = null

  const release = (lock) => {
    if (lock === null) return
    tryReleaseLockFile(lock)
    if (heldLock === lock) heldLock = null
  }

  // 持ったまま次を取ると、先のロックが誰にも外されずに残る。取る前に止める。
  // Issue の実装と衝突の解消は、同じこのロックで互いを締め出す。ロック名を片方だけ変えると、同じ Issue で両方が同時に走る
  const tryAcquire = (issueNumber) => {
    if (heldLock !== null) {
      throw new TechnicalError(
        `Issue のロックを持ったまま #${issueNumber} のロックを取ろうとしました: ${heldLock.lockFilePath}`
      )
    }
    const { lock, holderPid } = tryAcquireNamedLockFile({
      lockDirectory: LOCK_DIRECTORY,
      lockName: `issue-${issueNumber}`
    })
    if (lock === null) {
      return { lock: null, skipReason: `PID ${holderPid ?? '（読めず）'} のプロセスが着手中です` }
    }
    heldLock = lock
    return { lock, skipReason: null }
  }

  return { tryAcquire, release, releaseHeld: () => release(heldLock) }
}

/**
 * ロックを外す。外せなくても投げない。
 *
 * シグナルのリスナからも呼ぶので、投げるとシグナルでの終了に至らない。外せずに残ったロックは、PID のプロセスが
 * いなくなった時点で、次に取ろうとしたプロセスが死んだとみなして取り直す。
 *
 * @param {Parameters<typeof releaseLockFile>[0]} lock 外すロック
 * @returns {void}
 */
function tryReleaseLockFile(lock) {
  try {
    releaseLockFile(lock)
  } catch (error) {
    showWarning(`ロック ${lock.lockFilePath} を外せませんでした: ${formatErrorMessage(error)}`)
  }
}
