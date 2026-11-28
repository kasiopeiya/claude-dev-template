// 責務: AI 専用 clone の中で `claude` を起動し、Issue 1件ぶんの Skill を1つずつ無人セッションとして走らせ、終了状態が正常終了かを判定する。
//
// 設計意図（WHY）:
// - Issue ごと・Skill ごとにプロセスを作り直す。1つのセッションで何件も処理すると文脈が積もり、品質が
//   落ちる。監査と実装を分けるのは、実装セッションが差し替わった本文をクリーンな文脈で読むため。
// - 手順そのものは各 Skill の SKILL.md が持つ。ここが渡すのは Issue 番号だけで、
//   プロンプト文字列に手順を書かない（書くとドキュメントレビューの対象外になる）。
// - 時間で打ち切る。無人のセッションが固まると、止める手段は起動側にしか無い。
// - セッション中は経過時間をステータス行に出し続ける。claude は長いツール呼び出しの間、何分も文章を出さないことがあり、
//   無音のままだと、人間は固まったのか動いているのかを見分けられない（Issue #782）。TTY では上限までの
//   残りが一目で分かるよう、スピナーとプログレスバーで出す。
// - セッションの終わりに、終了状態と所要時間の行を出す。無いと、何分かかったかを時刻の引き算でしか知れない。
// - stream-json（イベントを1行1件の JSON で流す出力形式）で起動し、イベントをセッションごとのファイルに残す。
//   遅い理由や使用制限の状態は、イベントの中にしか無い（#2023）。CLI の JSON 出力形式は黙って変わりうるので、
//   その形式への依存を小さく保つ手立ては sessionEventRelay.mjs が持つ。
// - セッション ID はこちらで決めて `--session-id` で渡す。最初のイベントを待たずに、記録のファイル名が決まる。

import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'

import { TechnicalError } from '../lib/errors.mjs'
import { config } from './config.mjs'
import { createSessionEventRelay } from './sessionEventRelay.mjs'
import { buildSessionModelArgs } from './sessionModel.mjs'
import { runStreamingAsync } from './shell.mjs'
import { createThrottledStatusLine, showInfo, showSuccess, showWarning } from './ui.mjs'
import { buildSessionProgressText, formatElapsedTime, pickSpinnerFrame } from './uiFormat.mjs'
import {
  UNATTENDED_SESSION_ENV_NAME,
  UNATTENDED_SESSION_ENV_VALUE
} from './unattendedSessionEnv.mjs'

const MILLISECONDS_PER_MINUTE = 60 * 1000

// 非TTY で経過時間を追記する間隔。1秒ごとの経過表示をそのまま追記すると、1セッションで数千行に膨らむ
const ELAPSED_TIME_APPEND_INTERVAL_MS = 5 * MILLISECONDS_PER_MINUTE

/**
 * `/issue-check #<Issue番号>` を無人セッションとして実行する。判定を Issue へ書き戻す手順は Skill が持ち、
 * 終了コード 0 は書き戻しが済んだことを保証しない。
 *
 * @param {{ issueNumber: number, workspaceDir: string, abortSignal: AbortSignal }} params 監査させる Issue の番号・セッションを動かす AI 専用 clone・中止の合図（runUnattendedSession を参照）
 * @returns {Promise<{ exitCode: number, signal: string | null }>} claude プロセスの終了状態（打ち切られたときは signal が入る）
 * @throws {Error} claude を起動できなかったとき
 */
export function runIssueCheckSession({ issueNumber, workspaceDir, abortSignal }) {
  // `#` を付ける。素の数字は /issue-check が件数として読む
  return runUnattendedSession({
    slashCommand: `/issue-check #${issueNumber}`,
    workspaceDir,
    abortSignal
  })
}

/**
 * `/auto-dev <Issue番号>` を無人セッションとして実行する。
 *
 * @param {{ issueNumber: number, workspaceDir: string, abortSignal: AbortSignal }} params 実装させる Issue の番号・セッションを動かす AI 専用 clone・中止の合図（runUnattendedSession を参照）
 * @returns {Promise<{ exitCode: number, signal: string | null }>} claude プロセスの終了状態（打ち切られたときは signal が入る）
 * @throws {Error} claude を起動できなかったとき
 */
export function runAutoDevSession({ issueNumber, workspaceDir, abortSignal }) {
  return runUnattendedSession({
    slashCommand: `/auto-dev ${issueNumber}`,
    workspaceDir,
    abortSignal
  })
}

/**
 * `/auto-fix-ci <Issue番号> <run ID>` を無人セッションとして実行する。
 *
 * @param {{ issueNumber: number, runId: number, workspaceDir: string, abortSignal: AbortSignal }} params 直させる Issue の番号と、落ちた CI の run ID（どちらも数値なので、取り違えないよう名前で渡す）、セッションを動かす AI 専用 clone、中止の合図（runUnattendedSession を参照）
 * @returns {Promise<{ exitCode: number, signal: string | null }>} claude プロセスの終了状態（打ち切られたときは signal が入る）
 * @throws {Error} claude を起動できなかったとき
 */
export function runAutoFixCiSession({ issueNumber, runId, workspaceDir, abortSignal }) {
  return runUnattendedSession({
    slashCommand: `/auto-fix-ci ${issueNumber} ${runId}`,
    workspaceDir,
    abortSignal
  })
}

/**
 * `/auto-resolve-conflict <Issue番号>` を無人セッションとして実行する。clone は、衝突した PR のブランチへ切り替えてから渡す。
 *
 * @param {{ issueNumber: number, workspaceDir: string, abortSignal: AbortSignal }} params 衝突した PR の Issue の番号・セッションを動かす AI 専用 clone・中止の合図（runUnattendedSession を参照）
 * @returns {Promise<{ exitCode: number, signal: string | null }>} claude プロセスの終了状態（打ち切られたときは signal が入る）
 * @throws {Error} claude を起動できなかったとき
 */
export function runAutoResolveConflictSession({ issueNumber, workspaceDir, abortSignal }) {
  return runUnattendedSession({
    slashCommand: `/auto-resolve-conflict ${issueNumber}`,
    workspaceDir,
    abortSignal
  })
}

/**
 * イベントの記録の置き場の設定が、絶対パスであることを確かめる。config.mjs はテンプレート同期の対象外で、
 * 同期した利用先では欠けうる。欠けたまま動かすと、Issue を拾ってカードを動かした後のセッションの起動で落ちるので、
 * Issue を拾う前に止める。
 *
 * @param {unknown} sessionEventLogDir config.mjs の `sessionEventLogDir`
 * @returns {void}
 * @throws {TechnicalError} 欠けている・文字列でない・絶対パスでないとき
 */
export function validateSessionEventLogDir(sessionEventLogDir) {
  if (typeof sessionEventLogDir === 'string' && isAbsolute(sessionEventLogDir)) return
  throw new TechnicalError(
    `scripts/auto-programmer/config.mjs の sessionEventLogDir を絶対パスで指定してください（いまの値: ${String(sessionEventLogDir)}）。テンプレートの config.mjs と同じく resolve(autoProgrammerHomeDir, 'session-events') を足せば、既定の置き場になります`
  )
}

/**
 * claude プロセスが正常終了したか。
 *
 * @param {{ exitCode: number, signal: string | null }} status 終了状態
 * @returns {boolean} 終了コード 0 で、シグナルで止められていなければ true
 */
export function hasSessionSucceeded({ exitCode, signal }) {
  return exitCode === 0 && signal === null
}

/**
 * スラッシュコマンド1つを無人セッションとして実行する。
 *
 * @param {{ slashCommand: string, workspaceDir: string, abortSignal: AbortSignal }} params 実行するスラッシュコマンド（引数を含む）・セッションを動かす AI 専用 clone・中止の合図（中止されると reason のシグナルを claude へ子孫ごと送る）
 * @returns {Promise<{ exitCode: number, signal: string | null }>} claude プロセスの終了状態（打ち切られたときは signal が入る）
 * @throws {Error} claude を起動できなかったとき
 */
async function runUnattendedSession({ slashCommand, workspaceDir, abortSignal }) {
  showInfo(`▶ ${slashCommand} を実行`)
  const timeoutMs = config.sessionTimeoutMinutes * MILLISECONDS_PER_MINUTE
  const showSessionProgress = createThrottledStatusLine({
    minAppendIntervalMs: ELAPSED_TIME_APPEND_INTERVAL_MS
  })
  const startedAt = Date.now()
  const sessionId = randomUUID()
  const sessionEventRelay = createSessionEventRelay({
    eventLogFilePath: prepareSessionEventLogFilePath({
      startedAt: new Date(startedAt),
      slashCommand,
      sessionId
    })
  })
  const exitStatus = await runStreamingAsync(
    'claude',
    buildClaudeSessionArgs({ slashCommand, sessionId }),
    {
      cwd: workspaceDir,
      // 中で動く hook と Skill が無人だと見分けるため（読み手と理由は unattendedSessionEnv.mjs）
      extraEnv: { [UNATTENDED_SESSION_ENV_NAME]: UNATTENDED_SESSION_ENV_VALUE },
      timeoutMs,
      abortSignal,
      onTick: (elapsedMs) =>
        showSessionProgress(
          `実行中… 経過 ${formatElapsedTime(elapsedMs)} / 上限${config.sessionTimeoutMinutes}分`,
          {
            liveMessage: buildSessionProgressText({ elapsedMs, limitMs: timeoutMs }),
            symbol: pickSpinnerFrame(elapsedMs)
          }
        ),
      onOutput: sessionEventRelay.onOutput
    }
  )
  // runStreamingAsync は出力を読み切ってから返るので、改行で終わらない最後の行はここで処理する
  sessionEventRelay.flush()
  showSessionOutcome(slashCommand, exitStatus, Date.now() - startedAt)
  return exitStatus
}

/**
 * 無人セッションの claude に渡す引数を組み立てる。
 *
 * @param {{ slashCommand: string, sessionId: string }} params 実行するスラッシュコマンド（引数を含む）・`--session-id` に渡すセッション ID
 * @returns {string[]} claude の引数
 */
function buildClaudeSessionArgs({ slashCommand, sessionId }) {
  // 権限確認を飛ばして起動する。無人セッションには権限プロンプトへ答える人間がおらず、
  // `--allowedTools` での列挙は漏れたところで空転するため（README.md「使う前に済ませておくこと」）。
  // この形は .claude/hooks/forbiddenCommandMatcher.mjs が「ゲートの迂回」として禁じているが、
  // それは Bash ツールへ渡すコマンドへの禁止であり、ローカルのファイルへの影響は AI 専用 clone の中に閉じる。
  // clone の中でも .claude/hooks/ のガードは効き続け、このツール自体の起動も AI には禁じている。
  // 無人セッションは完了通知で進むので、予約系のツールは要らない。ScheduleWakeup・CronCreate は
  // 「あとで自分に指示を送り直す」ツールで、使われると Skill が同じ作業を繰り返し、打ち切りまで
  // 止まらない（#1119・#1497：/issue-check #1497 が約11分おきに6回走った）。Skill 本文に「使うな」と
  // 書く方法は書き漏らしで再発するので、起動時にツールを外す。deny は権限確認を飛ばすモードでも効く。
  return [
    '-p',
    slashCommand,
    '--dangerously-skip-permissions',
    '--disallowedTools',
    'ScheduleWakeup',
    'CronCreate',
    '--session-id',
    sessionId,
    '--output-format',
    'stream-json',
    // -p で stream-json を使うには --verbose が要る
    '--verbose',
    ...buildSessionModelArgs(config)
  ]
}

/**
 * セッション1つぶんのイベントを残すファイルのパスを決め、置き場のディレクトリを作る。
 * ディレクトリは起動前に作る。出力の中継中に作れず例外になると、捕まえる場所が無く、このツールごと落ちて claude だけが残る。
 *
 * @param {{ startedAt: Date, slashCommand: string, sessionId: string }} sessionIdentity セッションの開始時刻・実行するスラッシュコマンド・セッション ID
 * @returns {string} イベントを追記するファイルの絶対パス
 */
function prepareSessionEventLogFilePath({ startedAt, slashCommand, sessionId }) {
  mkdirSync(config.sessionEventLogDir, { recursive: true })
  return resolve(
    config.sessionEventLogDir,
    buildSessionEventLogFileName({ startedAt, slashCommand, sessionId })
  )
}

/**
 * セッション1つぶんのイベントを残すファイルの名前を作る。開始時刻・スラッシュコマンド・セッション ID の順に並べる。
 * 開始時刻を先頭に置くのは、名前の順に並べれば古い順になり、実行記録（runs.jsonl）の時刻から引けるため。
 * 時刻の `:` は Windows のファイル名に使えないので `-` に置き換える。
 *
 * @param {{ startedAt: Date, slashCommand: string, sessionId: string }} sessionIdentity セッションの開始時刻・実行するスラッシュコマンド（引数を含む）・`claude --session-id` に渡したセッション ID
 * @returns {string} ファイル名（例：`2026-11-28T01-35-37-123Z-auto-dev-2023-<セッション ID>.jsonl`）
 */
function buildSessionEventLogFileName({ startedAt, slashCommand, sessionId }) {
  const sortableTimestamp = startedAt.toISOString().replaceAll(/[:.]/g, '-')
  const slashCommandPart = slashCommand.replaceAll(/[^A-Za-z0-9]+/g, '-').replaceAll(/^-|-$/g, '')
  return `${sortableTimestamp}-${slashCommandPart}-${sessionId}.jsonl`
}

/**
 * セッション1つの終わりを、終了状態と所要時間の1行で示す。
 *
 * @param {string} slashCommand 実行したスラッシュコマンド
 * @param {{ exitCode: number, signal: string | null }} status claude プロセスの終了状態
 * @param {number} elapsedMs 所要時間（ミリ秒）
 * @returns {void}
 */
function showSessionOutcome(slashCommand, { exitCode, signal }, elapsedMs) {
  const elapsedTime = formatElapsedTime(elapsedMs)
  if (exitCode === 0 && signal === null) {
    showSuccess(`${slashCommand}  ${elapsedTime}`)
    return
  }
  const exitStatusText = signal === null ? `終了コード ${exitCode}` : `シグナル ${signal} で停止`
  showWarning(`${slashCommand}  ${exitStatusText}  ${elapsedTime}`)
}
