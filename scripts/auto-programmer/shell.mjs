// 責務: 外部コマンド（gh・git・npm・claude）の起動を1か所にまとめる。
//
// 設計意図（WHY）:
// - 既定はシェルを介さない起動。引数はすべて配列で渡すので、Issue タイトルや
//   ブランチ名に記号が混じってもシェルに解釈されない。例外は Windows の npm-shim（.cmd）
//   フォールバック（windowsShimFallback.mjs）のみである。
// - 呼び分けは「出力を受け取る」と「端末へ流す」の2通りで、「失敗を例外にする」「JSON として読む」は
//   前者に重ねたものである。
// - 基本は同期の spawnSync で待つ。例外は claude セッション用の runStreamingAsync だけである。
//   spawnSync の間は Node のタイマーが1つも発火せず、数十分に及ぶセッション（上限は config.sessionTimeoutMinutes）の
//   間、画面を更新する手段が無い（Issue #782）。短時間で終わる npm ci（出力は取り込む）・clone（自前で進捗を流す）は同期で待つ。待つ間に画面を更新しなくても困らない。
// - runStreamingAsync は子の出力を端末へ直結せず、パイプで受けて中継する。直結すると、その場更新中の
//   ステータス行の末尾へ子の出力が連結される。中継は内容を解析しない素通しにして、claude の出力形式に依存しない。
// - runStreamingAsync の打ち切りはプロセスツリーごと止める。spawn の timeout は直下の子しか殺さず、孫（Windows の
//   .cmd 経由なら本体の claude）が AI 専用 clone を書き換え続けて次の Issue とぶつかる（Issue #791）。
//   時間切れで SIGTERM が効かない子が居ると exit が来ず待ちが終わらないので、猶予の後に SIGKILL へ切り替える。
//   POSIX では子を別のプロセスグループで起動するので、端末のシグナルは子に届かず、stopSignals.mjs のリスナが中継する。
//   中継できない SIGKILL で親を止めると子は残る。Ctrl+Z（SIGTSTP）も中継しないので、止まるのは親だけで子は動き続ける。

import { spawn, spawnSync } from 'node:child_process'
import { constants } from 'node:os'

import { TechnicalError } from '../lib/errors.mjs'
import {
  spawnWithWindowsShimFallback,
  spawnWithWindowsShimFallbackAsync
} from './windowsShimFallback.mjs'

// 標準出力として受け取れる上限。gh の JSON 出力がこれを超えると ENOBUFS で落ちる
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

// 経過表示は秒単位なので、これより細かく呼んでも表示は変わらない
const ELAPSED_TIME_TICK_INTERVAL_MS = 1000

// 子が終了してから、パイプに残った出力を読み切るまで待つ上限。孫プロセスがパイプを握ったまま残ると
// パイプはいつまでも閉じないので、ここで打ち切って読むのをやめる
const OUTPUT_DRAIN_GRACE_MS = 5000

// 時間切れで SIGTERM を送ってから SIGKILL へ切り替えるまでの猶予。SIGKILL は後片付けの機会を奪うので、まず SIGTERM で頼む
const FORCE_KILL_GRACE_MS = 5000

// 中止の合図（AbortSignal）に載せて、2つ目以降のシグナルを子へ中継するイベントの名前。abort が通知するのは最初の1回だけで、
// 中止の後に来たシグナル（Ctrl+C の後の SIGTERM など）は、これで知らせないと子へ届かない
const RELAY_SIGNAL_EVENT_NAME = 'relay-signal'

/**
 * コマンドを実行し、標準出力を文字列で受け取る。
 *
 * @param {string} command 実行するコマンド
 * @param {string[]} args 引数（クォートしない素の値）
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
 * 打ち切りの時間は受け取らない。spawnSync の timeout は直下の子しか止めないので、打ち切りが要る長い処理は
 * runStreamingAsync で起動する。
 *
 * @param {string} command 実行するコマンド
 * @param {string[]} args 引数
 * @param {{ cwd?: string }} [options] 実行ディレクトリ
 * @returns {{ exitCode: number, signal: string | null }} 終了状態
 * @throws {Error} コマンドを起動できなかったとき（PATH に無い・.cmd に渡せない引数がある など）
 */
export function runStreaming(command, args, options = {}) {
  const result = spawnWithWindowsShimFallback(
    (resolvedCommand, resolvedArgs, extraOptions) =>
      spawnSync(resolvedCommand, resolvedArgs, {
        cwd: options.cwd,
        stdio: 'inherit',
        ...extraOptions
      }),
    command,
    args
  )
  if (result.error) throw result.error
  return readExitStatus(result)
}

/**
 * コマンドを非同期に実行し、子の出力を中継しながら終了を待つ。待っている間も Node のタイマーが動くので、
 * onTick で経過を画面に出せる。claude セッション専用（使い分けはファイル冒頭の設計意図を参照）。
 *
 * 子には標準入力を渡さない。子は POSIX では親と別のプロセスグループで動くので、端末の Ctrl+C や切断は子に
 * 届かない。子を止めたいときは、abortSignal の持ち主を sendSignalToWatchedChildren に渡してシグナルを送る（子孫ごと届く）。
 *
 * @param {string} command 実行するコマンド
 * @param {string[]} args 引数
 * @param {{ cwd: string, extraEnv?: Record<string, string>, timeoutMs: number, abortSignal: AbortSignal, onTick: (elapsedMs: number) => void, onOutput: (streamName: 'stdout' | 'stderr', chunk: Buffer) => void }} options 実行ディレクトリ・親の環境変数に足す環境変数・打ち切るまでの時間・中止の合図・1秒ごとに経過時間を受け取る関数・子の出力の中継先
 * @returns {Promise<{ exitCode: number, signal: string | null }>} 終了状態（打ち切られたときは signal が入る）
 * @throws {Error} コマンドを起動できなかったとき（PATH に無い・.cmd に渡せない引数がある など）
 */
export async function runStreamingAsync(
  command,
  args,
  { cwd, extraEnv, timeoutMs, abortSignal, onTick, onOutput }
) {
  const startedAt = Date.now()
  const tickTimer = setInterval(() => onTick(Date.now() - startedAt), ELAPSED_TIME_TICK_INTERVAL_MS)
  try {
    // 打ち切っても error は出さず、signal を入れて返す
    const result = await spawnWithWindowsShimFallbackAsync(
      (resolvedCommand, resolvedArgs, extraOptions) =>
        spawnAndWaitForExit(resolvedCommand, resolvedArgs, {
          cwd,
          extraEnv,
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
 * @throws {TechnicalError} 起動できなかったとき・終了コードが 0 以外のとき（標準エラー出力をメッセージに含める）
 */
export function runOrThrow(command, args, options = {}) {
  const { exitCode, signal, stdout, stderr } = runCapture(command, args, options)
  if (exitCode !== 0) {
    const exitStatusText = signal ? `signal ${signal}` : `exit ${exitCode}`
    throw new TechnicalError(
      `${command} ${args.join(' ')} が失敗しました (${exitStatusText})\n${stderr}`
    )
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
 * @throws {TechnicalError} コマンドが失敗したとき・出力が JSON でないとき
 */
export function runJson(command, args, options = {}) {
  const stdout = runOrThrow(command, args, options)
  try {
    return JSON.parse(stdout)
  } catch {
    throw new TechnicalError(
      `${command} ${args.join(' ')} の出力が JSON ではありません:\n${stdout}`
    )
  }
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
 * @param {{ cwd?: string, shell?: boolean, extraEnv?: Record<string, string> }} options 実行ディレクトリと、シェルを介すか、親の環境変数に足す環境変数
 * @returns {{ child: import('node:child_process').ChildProcess, killTree: (signal: NodeJS.Signals) => void }} 子プロセスと、子孫ごと止める関数（子がもう居なければ何もしない）
 */
function spawnProcessTree(command, args, { cwd, shell, extraEnv }) {
  const usesProcessGroup = process.platform !== 'win32'
  const child = spawn(command, args, {
    cwd,
    shell,
    env: { ...process.env, ...extraEnv },
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
 * 親が受けた終了シグナルを、見張っている子へ子孫ごと送る。受けるたびに呼んでよい。
 *
 * 最初の1つは controller を中止して送り（reason に入る）、2つ目以降は中止済みで abort が何も通知しないので、
 * イベントで送る。どちらで送るかはここが決める。呼び出し側が使い分けると、最初のシグナルが子へ2回届いたり、届かなかったりする。
 *
 * @param {AbortController} stopController runStreamingAsync に渡す abortSignal の持ち主（その signal を包まずにそのまま渡すこと。包むと、中止は伝わるがイベントは伝わらない）
 * @param {NodeJS.Signals} signalName 子のグループへ送るシグナル
 * @returns {void}
 */
export function sendSignalToWatchedChildren(stopController, signalName) {
  if (!stopController.signal.aborted) {
    stopController.abort(signalName)
    return
  }
  stopController.signal.dispatchEvent(
    new CustomEvent(RELAY_SIGNAL_EVENT_NAME, { detail: signalName })
  )
}

/**
 * 子への打ち切り（時間切れ・呼び出し側からの中止）を見張り、子孫ごと止める。見張りは子が終わると自分で片付ける。
 *
 * 時間切れでは SIGTERM を送り、FORCE_KILL_GRACE_MS を過ぎても子が終わらなければ SIGKILL を送る。
 * 中止の合図は AbortSignal で受け、reason に入ったシグナルをそのまま子のグループへ送る。中止の後に来たシグナルは
 * sendSignalToWatchedChildren のイベントで受けて送る。親が受けたシグナルをどう扱うか（中継するか・親も終わるか）は
 * stopSignals.mjs のリスナが決め、ここはプロセス全体のシグナルに触れない。
 *
 * @param {{ child: import('node:child_process').ChildProcess, killTree: (signal: NodeJS.Signals) => void }} processTree 見張る子プロセスと、子孫ごと止める関数
 * @param {{ timeoutMs: number, abortSignal: AbortSignal }} triggers 打ち切るまでの時間と、中止の合図（reason に送るシグナル名。シグナル名でなければ SIGTERM）
 * @returns {{ wasTimedOut: () => boolean }} 時間切れで止めたかを返す関数
 */
function watchForTermination({ child, killTree }, { timeoutMs, abortSignal }) {
  let isTimedOut = false
  let forceKillTimer
  const timeoutTimer = setTimeout(() => {
    isTimedOut = true
    killTree('SIGTERM')
    forceKillTimer = setTimeout(() => killTree('SIGKILL'), FORCE_KILL_GRACE_MS)
  }, timeoutMs)
  const killOnAbort = () => {
    const reason = abortSignal.reason
    // 理由なしの abort() では reason が DOMException になる。シグナル名でなければ SIGTERM で止める
    killTree(typeof reason === 'string' && reason in constants.signals ? reason : 'SIGTERM')
  }
  const killOnRelayedSignal = (event) => killTree(event.detail)
  if (abortSignal.aborted) killOnAbort()
  abortSignal.addEventListener('abort', killOnAbort, { once: true })
  abortSignal.addEventListener(RELAY_SIGNAL_EVENT_NAME, killOnRelayedSignal)
  const stopWatching = () => {
    clearTimeout(timeoutTimer)
    clearTimeout(forceKillTimer)
    abortSignal.removeEventListener('abort', killOnAbort)
    abortSignal.removeEventListener(RELAY_SIGNAL_EVENT_NAME, killOnRelayedSignal)
  }
  child.once('exit', stopWatching)
  child.once('error', stopWatching)
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
 * @param {{ cwd: string, shell?: boolean, extraEnv?: Record<string, string>, timeoutMs: number, abortSignal: AbortSignal, onOutput: (streamName: 'stdout' | 'stderr', chunk: Buffer) => void }} params 実行ディレクトリ・シェルを介すか・親の環境変数に足す環境変数・打ち切るまでの時間・中止の合図・子の出力の中継先
 * @returns {Promise<{ error: Error | null, status: number | null, signal: string | null }>} 終了状態（打ち切ったときは signal が入る）
 */
function spawnAndWaitForExit(
  command,
  args,
  { cwd, shell, extraEnv, timeoutMs, abortSignal, onOutput }
) {
  return new Promise((resolve) => {
    const processTree = spawnProcessTree(command, args, { cwd, shell, extraEnv })
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
