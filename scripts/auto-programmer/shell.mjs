// 責務: 外部コマンド（gh・git・npm・claude）の起動を1か所にまとめる。
//
// 設計意図（WHY）:
// - 既定はシェルを介さない spawnSync。引数はすべて配列で渡すので、Issue タイトルや
//   ブランチ名に記号が混じってもシェルに解釈されない。例外は Windows の npm-shim（.cmd）
//   フォールバックのみで、そこでは引数を1つずつクォートし、クォートで守れない文字を含む引数は拒む（後述）。
// - 呼び分けは「出力を受け取る」と「端末へ流す」の2通りだけで、残りの2関数は前者に
//   「失敗を例外にする」「JSON として読む」を重ねたものである。
// - 標準出力の上限を既定（1MB）から広げている。gh の JSON 出力は MB 単位になりうる。

import { spawnSync } from 'node:child_process'

// 標準出力として受け取れる上限。gh の JSON 出力がこれを超えると ENOBUFS で落ちる
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

// cmd.exe のダブルクォートの中でも意味を持ち続ける文字。`"` はクォートを閉じ、`%` は環境変数を展開し、
// 改行はコマンドをそこで切る。どれもエスケープでは確実に守れないので、含む引数は渡さずに拒む
const CMD_UNSAFE_CHARACTER_PATTERN = /["%\r\n]/

/**
 * cmd.exe 経由で渡す引数を、空白で割れないようダブルクォートで囲む。
 *
 * shell: true の spawnSync は引数をクォートせずに空白でつなぐので、囲まないと
 * `claude -p "/auto-dev 123"` のプロンプトが `/auto-dev` と `123` の2つに割れる。
 *
 * @param {string} arg 引数
 * @returns {string} ダブルクォートで囲んだ引数
 * @throws {Error} cmd.exe のクォートで守れない文字を含むとき
 */
function quoteForCmd(arg) {
  if (CMD_UNSAFE_CHARACTER_PATTERN.test(arg)) {
    throw new Error(`cmd.exe 経由では安全に渡せない文字（" % 改行）を含む引数です: ${arg}`)
  }
  return `"${arg}"`
}

/**
 * Windows で npm-shim（.cmd バッチファイル）配布のコマンドが ENOENT だったとき、.cmd を付けて
 * shell 経由で1回だけ実行し直す。
 *
 * .cmd/.bat は CVE-2024-27980 の修正（Node.js 18.20.0+/20.12.0+/21.7.0+）以降、shell: true を
 * 明示しない限り EINVAL になる（Node.js が自動で shell 経由に切り替えてはくれない）。npm は
 * 常に .cmd 配布だが、claude はインストール方法により .exe（ネイティブインストーラー）にも
 * .cmd（npm 経由）にもなるため、コマンド名の決め打ちでは対応できず、実行結果で判定する。
 *
 * @param {(command: string, args: string[], extraOptions: { shell?: boolean }) => import('node:child_process').SpawnSyncReturns<string | Buffer>} spawnWithCommand コマンド名・引数・追加オプションを受け取って spawnSync を呼ぶ関数
 * @param {string} command 実行するコマンド
 * @param {string[]} args 引数（クォートしない素の値）
 * @returns {import('node:child_process').SpawnSyncReturns<string | Buffer>} spawnSync の結果
 * @throws {Error} .cmd で実行し直すときに、cmd.exe のクォートで守れない文字を含む引数があったとき
 */
export function spawnWithWindowsShimFallback(spawnWithCommand, command, args) {
  const result = spawnWithCommand(command, args, {})
  if (process.platform === 'win32' && result.error?.code === 'ENOENT') {
    return spawnWithCommand(`${command}.cmd`, args.map(quoteForCmd), { shell: true })
  }
  return result
}

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
 * @param {string[]} args 引数（クオート不要。シェルを介すときはここで囲む）
 * @param {{ cwd?: string }} [options] 実行ディレクトリ
 * @returns {{ exitCode: number, signal: string | null, stdout: string, stderr: string }} 終了状態と出力
 * @throws {Error} コマンドを起動できなかったとき（PATH に無い・出力が上限を超えた・.cmd に渡せない引数がある など）
 */
export function runCapture(command, args, options = {}) {
  const result = spawnWithWindowsShimFallback(
    (resolvedCommand, resolvedArgs, extraOptions) =>
      spawnSync(resolvedCommand, resolvedArgs, {
        cwd: options.cwd,
        encoding: 'utf8',
        maxBuffer: MAX_OUTPUT_BYTES,
        ...extraOptions
      }),
    command,
    args
  )
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
 * @throws {Error} コマンドを起動できなかったとき（PATH に無い・.cmd に渡せない引数がある など）
 */
export function runStreaming(command, args, options = {}) {
  const result = spawnWithWindowsShimFallback(
    (resolvedCommand, resolvedArgs, extraOptions) =>
      spawnSync(resolvedCommand, resolvedArgs, {
        cwd: options.cwd,
        stdio: 'inherit',
        timeout: options.timeoutMs,
        ...extraOptions
      }),
    command,
    args
  )
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
