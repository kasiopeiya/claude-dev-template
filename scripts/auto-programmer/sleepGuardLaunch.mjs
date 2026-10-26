// 責務: sleepGuard.mjs が起動するスリープ抑止コマンドを決める。プロセスを起動せずに確かめられるよう、起動とは分けて
//   純粋関数だけを置く。

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const moduleDir = dirname(fileURLToPath(import.meta.url))
const SLEEP_GUARD_SCRIPT_PATH = join(moduleDir, 'sleepGuard.ps1')

/**
 * OS ごとに、スリープを止め続ける常駐コマンドの起動内容を決める。
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
