// 責務: OS のアイドルスリープが `index.mjs` の生存中にだけ入らないようにする、ベストエフォートの保険を1か所にまとめる。
//
// 設計意図（WHY）:
// - 直る対象は sessionTimeoutMinutes の壁時計タイムアウトが OS スリープの間も進み続けること（Issue #651）。
//   spawnSync のタイムアウトをスリープ耐性のあるものへ作り替えるのは、shell.mjs の同期設計を非同期へ
//   全面的に変える大改修になるため選ばない。OS 側にスリープさせない方を選ぶ。
// - Linux は CLOCK_MONOTONIC がサスペンド中に止まるため対象外（何もしない）。
// - どちらのコマンドも「index.mjs が生きている間だけ」自分で判定して終了する。index.mjs 側に
//   明示的な停止処理を持たせない（異常終了時に停止し忘れる経路を作らないため）。
// - detached にするのは Ctrl+C 対策でもある。index.mjs は SIGINT を受けても実行中の1件を記録してから
//   終わる（drain）ので、その間もこの保険が生き続けなければならない。detached にしないと、ターミナルの
//   Ctrl+C がこの子プロセスにも届き、drain が終わる前にスリープ抑止が切れる。
// - 起動に失敗しても、あくまで保険なのでメインループを絶対に止めない。'error' ハンドラで必ず受け止める。

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const moduleDir = dirname(fileURLToPath(import.meta.url))
const SLEEP_GUARD_SCRIPT_PATH = join(moduleDir, 'sleepGuard.ps1')

/**
 * OS ごとに、スリープを止め続ける常駐コマンドの起動内容を決める。
 *
 * 実際にプロセスを起動せずに検証できるよう、純粋関数にしてある。
 *
 * @param {string} platform `process.platform` の値
 * @param {number} pid 生きている間だけスリープを止めたいプロセスの pid（`process.pid`）
 * @returns {{ command: string, args: string[] } | null} 起動するコマンドと引数（対象外の OS なら null）
 */
export function resolveSleepGuardLaunch(platform, pid) {
  if (platform === 'darwin') {
    // -i: アイドルスリープだけを止める（画面のスリープは止めない）。
    // -w: 指定した pid が居なくなったら caffeinate 自身が終了するので、index.mjs 側から止める必要が無い
    return { command: 'caffeinate', args: ['-i', '-w', String(pid)] }
  }
  if (platform === 'win32') {
    return {
      command: 'powershell.exe',
      args: [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        SLEEP_GUARD_SCRIPT_PATH,
        '-TargetPid',
        String(pid)
      ]
    }
  }
  // Linux などは CLOCK_MONOTONIC がサスペンド中に止まり、そもそも壁時計タイムアウトがスリープの影響を受けない
  return null
}

/**
 * `index.mjs` が生きている間、OS のアイドルスリープを止める。対象外の OS では何もしない。
 *
 * 起動に失敗しても例外にしない。これが無くても auto-programmer 自体は動くので、
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
  // 'error' はリスナが無いと例外として投げられ、無人のメインループごと落としてしまう。
  // caffeinate・powershell.exe が万一無くても、警告だけ出して続行する
  child.on('error', (error) => {
    console.error(`スリープ抑止の起動に失敗しました（続行します）: ${error.message}`)
  })
  child.unref()
}
