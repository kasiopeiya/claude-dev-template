// 責務: Windows で npm-shim（.cmd バッチファイル）配布のコマンドが起動できなかったとき、.cmd を付けて
//   shell 経由で実行し直す。shell.mjs の起動関数だけが使う。
//
// 設計意図（WHY）:
// - shell.mjs は既定でシェルを介さずに起動する。シェルを介すのはこのフォールバックだけなので、そこでは引数を
//   1つずつクォートし、クォートで守れない文字を含む引数は拒む。

import { TechnicalError } from '../lib/errors.mjs'

// cmd.exe のダブルクォートの中でも意味を持ち続ける文字。`"` はクォートを閉じ、`%` は環境変数を展開し、
// 改行はコマンドをそこで切る。どれもエスケープでは確実に守れないので、含む引数は渡さずに拒む
const CMD_UNSAFE_CHARACTER_PATTERN = /["%\r\n]/

/**
 * Windows で npm-shim（.cmd バッチファイル）配布のコマンドが ENOENT だったとき、.cmd を付けて
 * shell 経由で1回だけ実行し直す。
 *
 * @param {(command: string, args: string[], extraOptions: { shell?: boolean }) => import('node:child_process').SpawnSyncReturns<string | Buffer>} spawnWithCommand コマンド名・引数・追加オプションを受け取って spawnSync を呼ぶ関数
 * @param {string} command 実行するコマンド
 * @param {string[]} args 引数（クォートしない素の値）
 * @returns {import('node:child_process').SpawnSyncReturns<string | Buffer>} spawnSync の結果
 * @throws {TechnicalError} .cmd で実行し直すときに、cmd.exe のクォートで守れない文字を含む引数があったとき
 */
export function spawnWithWindowsShimFallback(spawnWithCommand, command, args) {
  const result = spawnWithCommand(command, args, {})
  const retry = findWindowsShimRetry(command, args, result.error)
  return retry ? spawnWithCommand(retry.command, retry.args, retry.extraOptions) : result
}

/**
 * spawnWithWindowsShimFallback の非同期版。起動の成否が非同期にしか分からない spawn 用。
 *
 * @param {(command: string, args: string[], extraOptions: { shell?: boolean }) => Promise<{ error: Error | null, status: number | null, signal: string | null }>} spawnWithCommand コマンド名・引数・追加オプションを受け取って spawn し、終了を待つ関数
 * @param {string} command 実行するコマンド
 * @param {string[]} args 引数（クォートしない素の値）
 * @returns {Promise<{ error: Error | null, status: number | null, signal: string | null }>} 終了状態
 * @throws {TechnicalError} .cmd で実行し直すときに、cmd.exe のクォートで守れない文字を含む引数があったとき
 */
export async function spawnWithWindowsShimFallbackAsync(spawnWithCommand, command, args) {
  const result = await spawnWithCommand(command, args, {})
  const retry = findWindowsShimRetry(command, args, result.error)
  return retry ? spawnWithCommand(retry.command, retry.args, retry.extraOptions) : result
}

/**
 * cmd.exe 経由で渡す引数を、空白で割れないようダブルクォートで囲む。
 *
 * shell: true の spawnSync は引数をクォートせずに空白でつなぐので、囲まないと
 * `claude -p "/auto-dev 123"` のプロンプトが `/auto-dev` と `123` の2つに割れる。
 *
 * @param {string} commandArgument 引数
 * @returns {string} ダブルクォートで囲んだ引数
 * @throws {TechnicalError} cmd.exe のクォートで守れない文字を含むとき
 */
function quoteForCmd(commandArgument) {
  if (CMD_UNSAFE_CHARACTER_PATTERN.test(commandArgument)) {
    throw new TechnicalError(
      `cmd.exe 経由では安全に渡せない文字（" % 改行）を含む引数です: ${commandArgument}`
    )
  }
  return `"${commandArgument}"`
}

/**
 * 起動に失敗したコマンドを、Windows の npm-shim（.cmd バッチファイル）として実行し直すべきかを判定し、
 * 実行し直すときの呼び方を返す。同期版と非同期版のフォールバックがこの判定を共有する。
 *
 * .cmd/.bat は CVE-2024-27980 の修正（Node.js 18.20.0+/20.12.0+/21.7.0+）以降、shell: true を
 * 明示しない限り EINVAL になる（Node.js が自動で shell 経由に切り替えてはくれない）。npm は
 * 常に .cmd 配布だが、claude はインストール方法により .exe（ネイティブインストーラー）にも
 * .cmd（npm 経由）にもなるため、コマンド名の決め打ちでは対応できず、実行結果で判定する。
 *
 * @param {string} command 実行したコマンド
 * @param {string[]} args 引数（クォートしない素の値）
 * @param {(Error & { code?: string }) | null | undefined} error 起動時のエラー
 * @returns {{ command: string, args: string[], extraOptions: { shell: boolean } } | null} 実行し直す呼び方（実行し直さないときは null）
 * @throws {TechnicalError} 実行し直すときに、cmd.exe のクォートで守れない文字を含む引数があったとき
 */
function findWindowsShimRetry(command, args, error) {
  if (process.platform !== 'win32' || error?.code !== 'ENOENT') return null
  return { command: `${command}.cmd`, args: args.map(quoteForCmd), extraOptions: { shell: true } }
}
