// 責務: OS のアイドルスリープが `index.mjs` の生存中にだけ入らないようにする、ベストエフォートの保険を1か所にまとめる。
//
// 設計意図（WHY）:
// - 防ぐのは、OS スリープの間も sessionTimeoutMinutes の打ち切りまでの時間が進み、セッションが打ち切られること
//   （Issue #651）。OS 側にスリープさせないことで防ぐ。対象の OS と起動するコマンドは sleepGuardLaunch.mjs が決める。
// - 起動するコマンド（caffeinate・sleepGuard.ps1）はどちらも「index.mjs が生きている間だけ」自分で判定して終了する。index.mjs 側に
//   明示的な停止処理を持たせない（異常終了時に停止し忘れる経路を作らないため）。
// - detached にするのは Ctrl+C 対策でもある。index.mjs は SIGINT を受けても実行中の1件を記録してから
//   終わる（drain）ので、その間もこの保険が生き続けなければならない。detached にしないと、ターミナルの
//   Ctrl+C がこの子プロセスにも届き、drain が終わる前にスリープ抑止が切れる。
// - 起動に失敗しても、起動した後に落ちても、あくまで保険なのでメインループを絶対に止めない。
//   'error' と 'exit' のハンドラで必ず受け止め、警告だけ出して続行する。

import { spawn } from 'node:child_process'

import { resolveSleepGuardLaunch } from './sleepGuardLaunch.mjs'
import { showWarning } from './ui.mjs'

/**
 * `index.mjs` が生きている間、OS のアイドルスリープを止める。対象外の OS では何もしない。
 *
 * 起動に失敗しても、起動した後に落ちても例外にしない。これが無くても auto-programmer 自体は動くので、
 * メインループを止めてまで守る価値が無いベストエフォートの保険である。
 *
 * @returns {void}
 */
export function startSleepGuard() {
  const launch = resolveSleepGuardLaunch(process.platform, process.pid)
  if (!launch) return

  const child = spawn(launch.command, launch.args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  })
  // 'error' の後に 'exit' が来るかは Node が保証しない。両方を受けるので、同じ失敗で警告を2回出さないよう1回に絞る
  let hasWarned = false
  const warnOnce = (message) => {
    if (hasWarned) return
    hasWarned = true
    showWarning(message)
  }
  // 'error' はリスナが無いと例外として投げられ、無人のメインループごと落としてしまう。
  // caffeinate・powershell.exe が万一無くても、警告だけ出して続行する
  child.on('error', (error) => {
    warnOnce(`スリープ抑止の起動に失敗しました（続行します）: ${error.message}`)
  })
  // 起動した後に落ちると、出力も残らず誰も気づけない（stdio: 'ignore'）ので、終了コードで知らせる。
  // 正常終了（index.mjs が居なくなって見張りが終わった）のときは何も出さない
  child.on('exit', (exitCode, terminationSignal) => {
    const message = describeSleepGuardExit(exitCode, terminationSignal)
    if (message) warnOnce(message)
  })
  child.unref()
}

/**
 * スリープ抑止の子プロセスが終わったとき、警告として出す文面を決める。
 *
 * @param {number | null} exitCode 子の終了コード（シグナルで終わったときは null）
 * @param {string | null} terminationSignal 子を終わらせたシグナル名（自分で終わったときは null）
 * @returns {string | null} 警告の文面（正常終了＝見張る pid が消えたときは null）
 */
function describeSleepGuardExit(exitCode, terminationSignal) {
  if (exitCode === 0) return null
  // シグナルで終わった子は exitCode が null になる。「終了コード null」と出さないよう文面を分ける
  if (exitCode === null) {
    return `スリープ抑止が途中で終わりました（シグナル ${terminationSignal} で終了。続行します）`
  }
  return `スリープ抑止が途中で終わりました（終了コード ${exitCode}。続行します）`
}
