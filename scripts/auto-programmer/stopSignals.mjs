// 責務: 終了シグナル（SIGINT・SIGHUP・SIGTERM・SIGQUIT）のリスナと、リスナが中止する stopController・リスナが読む着手中の Issue の番号を担う。
//   リスナは installStopSignalListeners で付ける。いつ付けるか（index.mjs の main）・いつ着手中の番号を控え・外すか（runWorkAndRecord.mjs）は呼び出し側が決める。
//   止める合図が来たら待たずに戻る sleepUnlessStopped も持つ（index.mjs の待機と watchCiAndFix.mjs の CI 待ちが共有する）。
//
// 設計意図（WHY）:
// - SIGINT は claude セッションへ送るだけで、後始末は index.mjs の finally に任せる。SIGHUP・SIGTERM・SIGQUIT は finally に届かないので、
//   claude への送信・Issue の `needs-human-check`・Issue のロック・clone の番号ロックの4つをリスナが束ねて呼ぶ。
//   index.mjs に置くと、シグナルの扱いを変えるたびに周回やフローと同じファイルを開き、変数・リスナ・代入の場所を同時に直すことになる。
// - stopController は export せず、読むだけの stopSignal を export する。外から abort すると、sendSignalToWatchedChildren の
//   使い分け（最初は abort、2つ目以降はイベント）を通らずに止まり、reason に最初に受けたシグナルが入る前提も崩れる。
// - リスナは import しただけでは付けない。import だけでプロセス全体の Ctrl+C の効き方が変わると、テストや別のスクリプトが
//   読んだだけで巻き込まれる。付ける呼び出しを、呼び出し側から見える形にする。
// - 着手中の Issue の番号は、このモジュールの外から代入し直せない（ES モジュールでは、import した側が let を代入できない）。
//   代入の口を setInFlightIssueNumber・clearInFlightIssueNumber に絞る。読むのはリスナだけで、同じこのモジュールの中にあるので、
//   読み出しの関数は作らない。
// - 呼び出し側を import しない。呼び出し側からこのモジュールへの一方向にして、循環を作らない。

import { setTimeout as sleep } from 'node:timers/promises'

import { tryMarkAsNeedsHumanCheck } from './issueWrite.mjs'
import { issueLockKeeper, releaseWorkspaceLock } from './processLocks.mjs'
import { sendSignalToWatchedChildren } from './shell.mjs'

// claude セッションは別のプロセスグループで動くので、端末のシグナルは届かない。受けたシグナルは、この controller を
// 通して同じシグナルを子孫ごと送る（reason には最初に受けたシグナルが入る。shell.mjs の sendSignalToWatchedChildren）
const stopController = new AbortController()

// 止める合図の読み口。controller 本体は渡さず、呼び出し側が読む・子へ渡すだけにする。包まずにそのまま渡すこと
// （包むと、中止は伝わるが sendSignalToWatchedChildren が送る中継のイベントは伝わらない）
export const stopSignal = stopController.signal

// 着手中の Issue の番号（着手中でなければ null）。シグナルで終わると runWorkAndRecord.mjs の runWorkAndRecord の finally に届かないので、
// 止まった印はリスナが付ける
let inFlightIssueNumber = null

/**
 * 終了シグナルのリスナを付ける。プロセスの生存中に1回だけ呼ぶ。
 *
 * リスナが外す clone の番号ロックを取る前に呼ぶこと。
 *
 * @returns {void}
 */
export function installStopSignalListeners() {
  // Ctrl+C を「実行中の1件を記録してから止める」にする。リスナが無いと node はその場で終了し、記録が残らない。
  // 2回目以降の Ctrl+C も claude へ届くよう、受けるたびに送る
  process.on('SIGINT', () => sendSignalToWatchedChildren(stopController, 'SIGINT'))

  // 端末の切断（SIGHUP）・SIGTERM・Ctrl+\（SIGQUIT）は、claude セッションへ送ってから、既定どおりこのプロセスも終わる。
  // once にするのは、送り直した同じシグナルでリスナが再び呼ばれず、既定の終了に至るようにするため
  for (const signalName of ['SIGHUP', 'SIGTERM', 'SIGQUIT']) {
    process.once(signalName, () => {
      sendSignalToWatchedChildren(stopController, signalName)
      if (inFlightIssueNumber !== null) tryMarkAsNeedsHumanCheck(inFlightIssueNumber)
      issueLockKeeper.releaseHeld()
      releaseWorkspaceLock()
      process.kill(process.pid, signalName)
    })
  }
}

/**
 * Ctrl+C が来ない限り、指定した時間だけ待つ。Ctrl+C が来たら待たずに戻る。
 *
 * @param {number} milliseconds 待つ時間
 * @returns {Promise<void>}
 */
export async function sleepUnlessStopped(milliseconds) {
  try {
    await sleep(milliseconds, undefined, { signal: stopSignal })
  } catch (error) {
    if (!(error instanceof Error && error.name === 'AbortError')) throw error
  }
}

/**
 * 着手中の Issue の番号を控える。シグナルで終わるとき、リスナがこの Issue に止まった印を付ける。
 *
 * @param {number} issueNumber 着手する Issue の番号
 * @returns {void}
 */
export function setInFlightIssueNumber(issueNumber) {
  inFlightIssueNumber = issueNumber
}

/**
 * 着手中の Issue の控えを外す。着手中でなければ何もしない。
 *
 * @returns {void}
 */
export function clearInFlightIssueNumber() {
  inFlightIssueNumber = null
}
