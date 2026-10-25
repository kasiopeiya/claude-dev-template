// 責務: 外部コマンドを1回実行し、標準出力を返すことのみを担う。失敗は、標準エラーをメッセージにした Error にして投げる。

import { execFileSync } from 'node:child_process'

/**
 * コマンドを1回実行し、標準出力の末尾の改行を落として返す。
 *
 * @param {string} command 実行するコマンド
 * @param {string[]} args コマンドに渡す引数
 * @returns {string} 標準出力
 * @throws {Error} コマンドが失敗したとき。メッセージはその標準エラー、`cause` は終了コード（`status`）を持つ子プロセスのエラー
 */
export function runCommand(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trimEnd()
  } catch (error) {
    throw new Error(String(error.stderr ?? error.message).trim(), { cause: error })
  }
}
