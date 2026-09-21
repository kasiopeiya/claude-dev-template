// 責務: 外部コマンド（gh・git・npm・claude）の起動を1か所にまとめる。
//
// 設計意図（WHY）:
// - シェルを介さない spawnSync 固定にしている。引数はすべて配列で渡すので、Issue タイトルや
//   ブランチ名に記号が混じってもシェルに解釈されない。
// - 呼び分けは「出力を受け取る」と「端末へ流す」の2通りだけで、残りの2関数は前者に
//   「失敗を例外にする」「JSON として読む」を重ねたものである。
// - 標準出力の上限を既定（1MB）から広げている。gh の JSON 出力は MB 単位になりうる。

import { spawnSync } from 'node:child_process'

// 標準出力として受け取れる上限。gh の JSON 出力がこれを超えると ENOBUFS で落ちる
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

/**
 * spawnSync の結果から終了コードを取り出す。シグナルで止まった場合も失敗として扱う。
 *
 * @param {import('node:child_process').SpawnSyncReturns<string | Buffer>} result spawnSync の結果
 * @returns {{ exitCode: number, signal: string | null }} 終了コードと、止めたシグナル
 */
function readExitStatus(result) {
  return { exitCode: result.status ?? 1, signal: result.signal ?? null }
}

/**
 * コマンドを実行し、標準出力を文字列で受け取る。
 *
 * @param {string} command 実行するコマンド
 * @param {string[]} args 引数（シェルを介さないのでクオート不要）
 * @param {{ cwd?: string }} [options] 実行ディレクトリ
 * @returns {{ exitCode: number, signal: string | null, stdout: string, stderr: string }} 終了状態と出力
 * @throws {Error} コマンドを起動できなかったとき（PATH に無い・出力が上限を超えた など）
 */
export function runCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    maxBuffer: MAX_OUTPUT_BYTES
  })
  if (result.error) throw result.error
  return { ...readExitStatus(result), stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/**
 * コマンドを実行し、出力をそのまま端末へ流す。実行中の様子を人間が見られるようにするための形。
 *
 * @param {string} command 実行するコマンド
 * @param {string[]} args 引数
 * @param {{ cwd?: string, timeoutMs?: number }} [options] 実行ディレクトリと、打ち切るまでの時間
 * @returns {{ exitCode: number, signal: string | null }} 終了状態（打ち切られたときは signal が入る）
 * @throws {Error} コマンドを起動できなかったとき（PATH に無い など）
 */
export function runStreaming(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    stdio: 'inherit',
    timeout: options.timeoutMs
  })
  // 打ち切りは ETIMEDOUT として error に入るが、止まったこと自体は終了状態で返す
  if (result.error && result.error.code !== 'ETIMEDOUT') throw result.error
  return readExitStatus(result)
}

/**
 * コマンドを実行し、失敗したら例外にする。
 *
 * @param {string} command 実行するコマンド
 * @param {string[]} args 引数
 * @param {{ cwd?: string }} [options] 実行ディレクトリ
 * @returns {string} 標準出力
 * @throws {Error} 起動できなかったとき・終了コードが 0 以外のとき（標準エラー出力をメッセージに含める）
 */
export function runOrThrow(command, args, options = {}) {
  const { exitCode, signal, stdout, stderr } = runCapture(command, args, options)
  if (exitCode !== 0) {
    const status = signal ? `signal ${signal}` : `exit ${exitCode}`
    throw new Error(`${command} ${args.join(' ')} が失敗しました (${status})\n${stderr}`)
  }
  return stdout
}

/**
 * コマンドの標準出力を JSON として読む。
 *
 * @param {string} command 実行するコマンド
 * @param {string[]} args 引数
 * @param {{ cwd?: string }} [options] 実行ディレクトリ
 * @returns {unknown} パースした JSON
 * @throws {Error} コマンドが失敗したとき・出力が JSON でないとき
 */
export function runJson(command, args, options = {}) {
  const stdout = runOrThrow(command, args, options)
  try {
    return JSON.parse(stdout)
  } catch {
    throw new Error(`${command} ${args.join(' ')} の出力が JSON ではありません:\n${stdout}`)
  }
}
