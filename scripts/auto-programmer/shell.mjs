// 責務: 外部コマンド（gh・git・npm・claude）の起動を1か所にまとめる。
//
// 設計意図（WHY）:
// - 既定はシェルを介さない起動。引数はすべて配列で渡すので、Issue タイトルや
//   ブランチ名に記号が混じってもシェルに解釈されない。例外は Windows の npm-shim（.cmd）
//   フォールバックのみで、そこでは引数を1つずつクォートし、クォートで守れない文字を含む引数は拒む（後述）。
// - 呼び分けは「出力を受け取る」と「端末へ流す」の2通りで、「失敗を例外にする」「JSON として読む」は
//   前者に重ねたものである。
// - 基本は同期の spawnSync で待つ。例外は claude セッション用の runStreamingAsync だけである。
//   spawnSync の間は Node のタイマーが1つも発火せず、数十分に及ぶセッション（上限は config.sessionTimeoutMinutes）の
//   間、画面を更新する手段が無い（Issue #782）。短時間で終わる npm ci（出力は取り込む）・clone（自前で進捗を流す）は同期のまま残し、非同期化の影響範囲を絞る。
// - runStreamingAsync は子の出力を端末へ直結せず、パイプで受けて中継する。直結すると、その場更新中の
//   ステータス行の末尾へ子の出力が連結される。中継は内容を解析しない素通しにして、claude の出力形式に依存しない。
// - runStreamingAsync の打ち切りはプロセスツリーごと止める。spawn の timeout は直下の子しか殺さず、孫（Windows の
//   .cmd 経由なら本体の claude）が AI 専用 clone を書き換え続けて次の Issue とぶつかる（Issue #791）。
//   POSIX では子を別のプロセスグループで起動するので、端末のシグナルは子に届かず、index.mjs が中継する。
//   中継できない SIGKILL で親を止めると子は残る。Ctrl+Z（SIGTSTP）も中継しないので、止まるのは親だけで子は動き続ける。
// - 標準出力の上限を既定（1MB）から広げている。gh の JSON 出力は MB 単位になりうる。

import { spawn, spawnSync } from 'node:child_process'
import { constants } from 'node:os'

// 標準出力として受け取れる上限。gh の JSON 出力がこれを超えると ENOBUFS で落ちる
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

// 経過表示は秒単位なので、これより細かく呼んでも表示は変わらない
const ELAPSED_TIME_TICK_INTERVAL_MS = 1000

// 子が終了してから、パイプに残った出力を読み切るまで待つ上限。孫プロセスがパイプを握ったまま残ると
// パイプはいつまでも閉じないので、ここで打ち切って読むのをやめる
const OUTPUT_DRAIN_GRACE_MS = 5000

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
 * @throws {Error} 実行し直すときに、cmd.exe のクォートで守れない文字を含む引数があったとき
 */
function findWindowsShimRetry(command, args, error) {
  if (process.platform !== 'win32' || error?.code !== 'ENOENT') return null
  return { command: `${command}.cmd`, args: args.map(quoteForCmd), extraOptions: { shell: true } }
}

/**
 * Windows で npm-shim（.cmd バッチファイル）配布のコマンドが ENOENT だったとき、.cmd を付けて
 * shell 経由で1回だけ実行し直す。
 *
 * @param {(command: string, args: string[], extraOptions: { shell?: boolean }) => import('node:child_process').SpawnSyncReturns<string | Buffer>} spawnWithCommand コマンド名・引数・追加オプションを受け取って spawnSync を呼ぶ関数
 * @param {string} command 実行するコマンド
 * @param {string[]} args 引数（クォートしない素の値）
 * @returns {import('node:child_process').SpawnSyncReturns<string | Buffer>} spawnSync の結果
 * @throws {Error} .cmd で実行し直すときに、cmd.exe のクォートで守れない文字を含む引数があったとき
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
 * @throws {Error} .cmd で実行し直すときに、cmd.exe のクォートで守れない文字を含む引数があったとき
 */
async function spawnWithWindowsShimFallbackAsync(spawnWithCommand, command, args) {
  const result = await spawnWithCommand(command, args, {})
  const retry = findWindowsShimRetry(command, args, result.error)
  return retry ? spawnWithCommand(retry.command, retry.args, retry.extraOptions) : result
}

/**
 * 子プロセスの終了結果（spawnSync の戻り値、または spawnAndWaitForExit の解決値）から終了コードを取り出す。
 * シグナルで止まった場合も失敗として扱う。
 *
 * @param {{ status: number | null, signal: string | null }} result 子プロセスの終了結果
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
 * 子プロセスを、子孫ごとまとめて止められる形で起動する。起動の形と止め方は対になっているので、1か所で決める。
 *
 * POSIX では子を別のプロセスグループ（detached）で起動し、グループ全体へシグナルを送って止める。
 * Windows で detached にすると子が別のコンソールを持つので使わず、taskkill でツリーごと強制終了する
 * （シグナルは選べない）。
 *
 * 標準入力は端末を引き継がず /dev/null にする。別グループの子が端末を読むと SIGTTIN で止まる。
 * パイプにもしない。claude -p が標準入力を読みに行き、閉じられるまで待つ。
 *
 * @param {string} command 実行するコマンド
 * @param {string[]} args 引数
 * @param {{ cwd?: string, shell?: boolean }} options 実行ディレクトリと、シェルを介すか
 * @returns {{ child: import('node:child_process').ChildProcess, killTree: (signal: NodeJS.Signals) => void }} 子プロセスと、子孫ごと止める関数（子がもう居なければ何もしない）
 */
function spawnProcessTree(command, args, { cwd, shell }) {
  const usesProcessGroup = process.platform !== 'win32'
  const child = spawn(command, args, {
    cwd,
    shell,
    detached: usesProcessGroup,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const killTree = (signal) => {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
    if (!usesProcessGroup) {
      const result = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore'
      })
      // taskkill が使えなくても直下の子だけは止め、exit を返させる。止まらないと待ちが終わらない
      if (result.error || result.status !== 0) child.kill(signal)
      return
    }
    try {
      process.kill(-child.pid, signal)
    } catch (error) {
      // 子が exit を通知する前にグループが消えていれば ESRCH になる。止める対象が無いだけなので無視する
      if (error.code !== 'ESRCH') throw error
    }
  }
  return { child, killTree }
}

/**
 * 子への打ち切り（時間切れ・呼び出し側からの中止）を見張り、子孫ごと止める。見張りは子が終わると自分で片付ける。
 *
 * 中止の合図は AbortSignal で受け、reason に入ったシグナルをそのまま子のグループへ送る。親が受けたシグナルを
 * どう扱うか（中継するか・親も終わるか）は入口の index.mjs が決め、ここはプロセス全体のシグナルに触れない。
 *
 * @param {{ child: import('node:child_process').ChildProcess, killTree: (signal: NodeJS.Signals) => void }} processTree 見張る子プロセスと、子孫ごと止める関数
 * @param {{ timeoutMs?: number, abortSignal?: AbortSignal }} triggers 打ち切るまでの時間と、中止の合図（reason に送るシグナル名。シグナル名でなければ SIGTERM）
 * @returns {{ wasTimedOut: () => boolean }} 時間切れで止めたかを返す関数
 */
function watchForTermination({ child, killTree }, { timeoutMs, abortSignal }) {
  let isTimedOut = false
  const timeoutTimer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          isTimedOut = true
          killTree('SIGTERM')
        }, timeoutMs)
  const killOnAbort = () => {
    const reason = abortSignal?.reason
    // 理由なしの abort() では reason が DOMException になる。シグナル名でなければ SIGTERM で止める
    killTree(typeof reason === 'string' && reason in constants.signals ? reason : 'SIGTERM')
  }
  if (abortSignal?.aborted) killOnAbort()
  abortSignal?.addEventListener('abort', killOnAbort, { once: true })
  const stop = () => {
    clearTimeout(timeoutTimer)
    abortSignal?.removeEventListener('abort', killOnAbort)
  }
  child.once('exit', stop)
  child.once('error', stop)
  return { wasTimedOut: () => isTimedOut }
}

/**
 * コマンドを1回 spawn し、終了を待つ。起動に失敗したときは例外にせず error に入れて返す
 * （Windows の .cmd で実行し直すかを呼び出し側が判定するため）。
 *
 * 終わりの合図は close ではなく exit にする。close は子の出力パイプがすべて閉じるまで来ず、止め損ねた孫が
 * パイプを握っていると打ち切っても戻らない。
 *
 * @param {string} command 実行するコマンド
 * @param {string[]} args 引数
 * @param {{ cwd?: string, shell?: boolean, timeoutMs?: number, abortSignal?: AbortSignal, onOutput: (streamName: 'stdout' | 'stderr', chunk: Buffer) => void }} params 実行ディレクトリ・シェルを介すか・打ち切るまでの時間・中止の合図・子の出力の中継先
 * @returns {Promise<{ error: Error | null, status: number | null, signal: string | null }>} 終了状態（打ち切ったときは signal が入る）
 */
function spawnAndWaitForExit(command, args, { cwd, shell, timeoutMs, abortSignal, onOutput }) {
  return new Promise((resolve) => {
    const processTree = spawnProcessTree(command, args, { cwd, shell })
    const { child } = processTree
    const watcher = watchForTermination(processTree, { timeoutMs, abortSignal })
    child.stdout.on('data', (chunk) => onOutput('stdout', chunk))
    child.stderr.on('data', (chunk) => onOutput('stderr', chunk))
    // 起動に失敗すると error の後に exit も来うる。先に来た方だけを採る（Promise は2回目の resolve を無視する）
    child.once('error', (error) => resolve({ error, status: null, signal: null }))
    child.once('exit', (status, exitSignal) => {
      // taskkill で止めた Windows では signal が入らないので、打ち切ったことを SIGTERM として揃える
      const signal = watcher.wasTimedOut() ? (exitSignal ?? 'SIGTERM') : exitSignal
      const drainTimer = setTimeout(() => {
        child.stdout.destroy()
        child.stderr.destroy()
      }, OUTPUT_DRAIN_GRACE_MS)
      // 読み切るか打ち切るかすると close が来る。どちらでも終了状態は exit で受けたものを返す
      child.once('close', () => {
        clearTimeout(drainTimer)
        resolve({ error: null, status, signal })
      })
    })
  })
}

/**
 * コマンドを非同期に実行し、子の出力を中継しながら終了を待つ。待っている間も Node のタイマーが動くので、
 * onTick で経過を画面に出せる。claude セッション専用（使い分けはファイル冒頭の設計意図を参照）。
 *
 * 子には標準入力を渡さない。子は POSIX では親と別のプロセスグループで動くので、端末の Ctrl+C や切断は子に
 * 届かない。子を止めたいときは abortSignal を中止する（reason に入れたシグナルを子孫ごと送る）。
 *
 * @param {string} command 実行するコマンド
 * @param {string[]} args 引数
 * @param {{ cwd?: string, timeoutMs?: number, abortSignal?: AbortSignal, onTick: (elapsedMs: number) => void, onOutput: (streamName: 'stdout' | 'stderr', chunk: Buffer) => void }} options 実行ディレクトリ・打ち切るまでの時間・中止の合図・1秒ごとに経過時間を受け取る関数・子の出力の中継先
 * @returns {Promise<{ exitCode: number, signal: string | null }>} 終了状態（打ち切られたときは signal が入る）
 * @throws {Error} コマンドを起動できなかったとき（PATH に無い・.cmd に渡せない引数がある など）
 */
export async function runStreamingAsync(
  command,
  args,
  { cwd, timeoutMs, abortSignal, onTick, onOutput }
) {
  const startedAt = Date.now()
  const tickTimer = setInterval(() => onTick(Date.now() - startedAt), ELAPSED_TIME_TICK_INTERVAL_MS)
  try {
    // 打ち切っても error は出さず、signal を入れて返す（同期版と同じ終了状態になる）
    const result = await spawnWithWindowsShimFallbackAsync(
      (resolvedCommand, resolvedArgs, extraOptions) =>
        spawnAndWaitForExit(resolvedCommand, resolvedArgs, {
          cwd,
          ...extraOptions,
          timeoutMs,
          abortSignal,
          onOutput
        }),
      command,
      args
    )
    if (result.error) throw result.error
    return readExitStatus(result)
  } finally {
    clearInterval(tickTimer)
  }
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
