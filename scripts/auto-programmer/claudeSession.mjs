// 責務: AI 専用 clone の中で `claude` を起動し、Issue 1件ぶんの Skill を1つずつ無人セッションとして走らせ、終了状態が正常終了かを判定する。
//
// 設計意図（WHY）:
// - Issue ごと・Skill ごとにプロセスを作り直す。1つのセッションで何件も処理すると文脈が積もり、品質が
//   落ちる。監査と実装を分けるのは、実装セッションが差し替わった本文をクリーンな文脈で読むため。
// - 手順そのものは各 Skill の SKILL.md が持つ。ここが渡すのは Issue 番号だけで、
//   プロンプト文字列に手順を書かない（書くとドキュメントレビューの対象外になる）。
// - 時間で打ち切る。無人のセッションが固まると、止める手段は起動側にしか無い。
// - セッション中は経過時間をステータス行に出し続ける。claude -p は終わるまで何も出さないことが多く、
//   無音のままだと、人間は固まったのか動いているのかを見分けられない（Issue #782）。TTY では上限までの
//   残りが一目で分かるよう、スピナーとプログレスバーで出す。
// - セッションの終わりに、終了状態と所要時間の行を出す。無いと、何分かかったかを時刻の引き算でしか知れない。

import { config } from './config.mjs'
import { buildSessionModelArgs } from './sessionModel.mjs'
import { runStreamingAsync } from './shell.mjs'
import {
  createThrottledStatusLine,
  relayChildProcessOutput,
  showInfo,
  showSuccess,
  showWarning
} from './ui.mjs'
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
  // 権限確認を飛ばして起動する。無人セッションには権限プロンプトへ答える人間がおらず、
  // `--allowedTools` での列挙は漏れたところで空転するため（README.md「使う前に済ませておくこと」）。
  // この形は .claude/hooks/forbiddenCommandMatcher.mjs が「ゲートの迂回」として禁じているが、
  // それは Bash ツールへ渡すコマンドへの禁止であり、ローカルのファイルへの影響は AI 専用 clone の中に閉じる。
  // clone の中でも .claude/hooks/ のガードは効き続け、このツール自体の起動も AI には禁じている。
  const exitStatus = await runStreamingAsync(
    'claude',
    ['-p', slashCommand, '--dangerously-skip-permissions', ...buildSessionModelArgs(config)],
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
      onOutput: relayChildProcessOutput
    }
  )
  showSessionOutcome(slashCommand, exitStatus, Date.now() - startedAt)
  return exitStatus
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
