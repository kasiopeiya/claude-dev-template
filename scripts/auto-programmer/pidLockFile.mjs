// 責務: 同じマシンで動く複数の auto-programmer が、1つのものを同時に使わないよう、PID 入りのロックファイルを取る・外す。
//   番号付きのロックは一番小さい空き番号を取り、名前付きのロックはその名前のものだけを取る。判断（死んだロック・空き番号）は pidLockFileDecision.mjs が持つ。
//
// 設計意図（WHY）:
// - npm の依存を足さず、Node の標準機能だけで作る（dependency-policy：依存は既定で足さない）。ロックの排他は、既にあれば失敗する
//   hard link の作成（linkSync）に任せる。中身を書き終えた一時ファイルを置くので、他のプロセスが書きかけの中身を読むことは無い。
// - 死んだロックの取り直しは、取り直しの印を排他で作れた1つのプロセスだけが行う。印の名前に死んだロックの中身を織り込むので、
//   別のプロセスが取り直し終えた後の新しいロックには効かない。2つのプロセスが同時に取り直しても、取れるのは1つだけになる。
// - 取り直しの途中で落ちたプロセスの印も、同じ手順で取り直す。印が残ったままだと、そのロックを誰も取り直せなくなる。

import { createHash, randomUUID } from 'node:crypto'
import { linkSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { uptime } from 'node:os'
import { join } from 'node:path'

import {
  buildLockFileContent,
  isLockDead,
  readLockHolderPid,
  selectLowestFreeNumber
} from './pidLockFileDecision.mjs'

/** @typedef {{ lockFilePath: string, lockFileContent: string }} AcquiredLockFile 取ったロックファイルのパスと、書いた中身 */

const MILLISECONDS_PER_SECOND = 1000

// 起動ごとに変わる ID の置き場。Linux（WSL2 を含む）にだけある
const BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id'

// 死んだロックを取り直したのに、作る前に別のプロセスに先を越されたときに、作り直す回数の上限
const MAX_CREATE_ATTEMPTS = 3

// 取り直しの印の、そのまた印を辿る深さの上限。印が残るのは取り直しの途中で落ちたときだけなので、深く辿ることはまず無い
const MAX_TAKEOVER_DEPTH = 3

/**
 * ファイルの中身を読む。
 *
 * @param {string} filePath 読むファイル
 * @returns {string | null} 中身（ファイルが無ければ null）
 * @throws {Error} 無い以外の理由で読めなかったとき
 */
function readFileIfExists(filePath) {
  try {
    return readFileSync(filePath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

/**
 * いまの起動の ID を引く。
 *
 * @returns {string | null} 起動の ID（引けない OS では null。そのときは起動時刻で見分ける）
 */
function readCurrentBootId() {
  try {
    return readFileSync(BOOT_ID_PATH, 'utf8').trim() || null
  } catch {
    // 引けなくても、起動時刻で見分ける手段が残るので止めない
    return null
  }
}

/**
 * PID のプロセスが動いているかを確かめる。シグナル 0 は届くかだけを確かめ、プロセスには何もしない。
 *
 * @param {number} pid 確かめるプロセスの PID
 * @returns {boolean} 動いていれば true
 */
function isProcessRunning(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM は、別のユーザーのプロセスとして動いている
    return error?.code === 'EPERM'
  }
}

/**
 * ロックが死んでいるかを、このマシンのいまの PID の状態と起動で決める。
 *
 * @param {string} lockFileContent ロックファイルの中身
 * @returns {boolean} 死んでいれば true
 */
function isLockDeadOnThisMachine(lockFileContent) {
  return isLockDead({
    lockFileContent,
    isProcessRunning,
    currentBoot: {
      bootedAtMs: Date.now() - uptime() * MILLISECONDS_PER_SECOND,
      bootId: readCurrentBootId()
    }
  })
}

/**
 * このプロセスを持ち主とするロックファイルを、無いときだけ作る。
 *
 * @param {string} lockFilePath 作るロックファイル
 * @returns {string | null} 書いた中身（既にあって作れなければ null）
 * @throws {Error} 既にある以外の理由で作れなかったとき
 */
function tryCreateLockFile(lockFilePath) {
  const lockFileContent = buildLockFileContent({
    pid: process.pid,
    createdAt: new Date(),
    bootId: readCurrentBootId()
  })
  const temporaryFilePath = `${lockFilePath}.${process.pid}-${randomUUID()}.tmp`
  try {
    writeFileSync(temporaryFilePath, lockFileContent, { flag: 'wx' })
    linkSync(temporaryFilePath, lockFilePath)
    return lockFileContent
  } catch (error) {
    if (error?.code === 'EEXIST') return null
    throw error
  } finally {
    rmSync(temporaryFilePath, { force: true })
  }
}

/**
 * ロックファイルが死んでいれば消す。消すのは、取り直しの印を作れた1つのプロセスだけにする。
 *
 * @param {string} lockFilePath 確かめるロックファイル
 * @param {number} depth 取り直しの印を辿った深さ（最初は 0）
 * @returns {boolean} 見たときのロックがもう無ければ true（生きている・ほかのプロセスが取り直している途中・印を辿る深さが上限に達したときは false）
 * @throws {Error} ファイルを読めなかった・作れなかった・消せなかったとき
 */
function tryRemoveDeadLockFile(lockFilePath, depth) {
  const deadLockFileContent = readFileIfExists(lockFilePath)
  if (deadLockFileContent === null) return true
  if (!isLockDeadOnThisMachine(deadLockFileContent) || depth >= MAX_TAKEOVER_DEPTH) return false

  const contentDigest = createHash('sha256').update(deadLockFileContent).digest('hex').slice(0, 16)
  const takeoverMarkPath = `${lockFilePath}.takeover-${contentDigest}`
  if (tryCreateLockFile(takeoverMarkPath) === null) {
    return (
      tryRemoveDeadLockFile(takeoverMarkPath, depth + 1) &&
      tryRemoveDeadLockFile(lockFilePath, depth + 1)
    )
  }
  try {
    // 印を作る前に、ほかのプロセスが取り直し終えて新しいロックを置いていれば、それは消さない
    if (readFileIfExists(lockFilePath) === deadLockFileContent) unlinkSync(lockFilePath)
  } finally {
    unlinkSync(takeoverMarkPath)
  }
  return true
}

/**
 * ロックを取る。死んだロックが残っていれば取り直す。
 *
 * @param {string} lockFilePath ロックファイル（置き場のディレクトリはあること）
 * @returns {AcquiredLockFile | null} 取ったロック。生きているロックがある・ほかのプロセスが取り直している途中・作り直しが上限回数で取れなかったときは null
 * @throws {Error} ファイルを読めなかった・作れなかった・消せなかったとき
 */
function tryAcquireLockFile(lockFilePath) {
  for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt++) {
    const lockFileContent = tryCreateLockFile(lockFilePath)
    if (lockFileContent !== null) return { lockFilePath, lockFileContent }
    if (!tryRemoveDeadLockFile(lockFilePath, 0)) return null
  }
  return null
}

/**
 * 1番から順に、一番小さい空き番号のロックを取る。ロックファイルは `<lockDirectory>/<lockFileNamePrefix>-<番号>.lock` に置く。
 *
 * @param {{ lockDirectory: string, lockFileNamePrefix: string }} params ロックファイルの置き場（無ければ作る）と、ファイル名の頭
 * @returns {{ lockNumber: number, lock: AcquiredLockFile }} 取った番号とロック
 * @throws {Error} ファイルを読めなかった・作れなかった・消せなかったとき
 */
export function acquireLowestFreeNumberedLockFile({ lockDirectory, lockFileNamePrefix }) {
  mkdirSync(lockDirectory, { recursive: true })
  const occupiedNumbers = new Set()
  for (;;) {
    const lockNumber = selectLowestFreeNumber(occupiedNumbers)
    const lock = tryAcquireLockFile(join(lockDirectory, `${lockFileNamePrefix}-${lockNumber}.lock`))
    if (lock !== null) return { lockNumber, lock }
    occupiedNumbers.add(lockNumber)
  }
}

/**
 * 名前で指したロックを1つ取る。ロックファイルは `<lockDirectory>/<lockName>.lock` に置く。
 *
 * @param {{ lockDirectory: string, lockName: string }} params ロックファイルの置き場（無ければ作る）と、拡張子を除いた名前
 * @returns {{ lock: AcquiredLockFile | null, holderPid: number | null }} 取ったロック（取れなければ null）と、取れなかったときのいまの持ち主の PID（取れた・持ち主を読めなかったときは null）
 * @throws {Error} ファイルを読めなかった・作れなかった・消せなかったとき
 */
export function tryAcquireNamedLockFile({ lockDirectory, lockName }) {
  mkdirSync(lockDirectory, { recursive: true })
  const lockFilePath = join(lockDirectory, `${lockName}.lock`)
  const lock = tryAcquireLockFile(lockFilePath)
  if (lock !== null) return { lock, holderPid: null }
  const holderLockFileContent = readFileIfExists(lockFilePath)
  return {
    lock: null,
    holderPid: holderLockFileContent === null ? null : readLockHolderPid(holderLockFileContent)
  }
}

/**
 * 取ったロックを外す。中身が取ったときと違えば（死んだとみなされて取り直された後なら）、他のプロセスのロックなので消さない。
 *
 * @param {AcquiredLockFile} lock acquireLowestFreeNumberedLockFile・tryAcquireNamedLockFile が返したロック
 * @returns {void}
 * @throws {Error} ファイルを読めなかった・消せなかったとき
 */
export function releaseLockFile({ lockFilePath, lockFileContent }) {
  if (readFileIfExists(lockFilePath) !== lockFileContent) return
  unlinkSync(lockFilePath)
}
