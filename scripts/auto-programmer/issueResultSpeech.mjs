// 責務: Issue 1件を終えたことと、その結果を OS の読み上げ機能で知らせる。
//
// 設計意図（WHY）:
// - 結果（完了・要確認・失敗など）を、タイトルより先に読む。人間が聞きたいのは「手当てが要るか」で、長いタイトルを
//   先に読むと結果が10秒ほど後になる。番号→結果→タイトルの順なら、最初の2秒で結果まで分かり、タイトルは聞き流せる。
// - 結果の分類は、画面の締めと同じもの（runOutcome.mjs）を受け取る。画面と耳で、手当てが要るかを食い違わせない（Issue #780）。
// - 読み上げの終わりを待たず、鳴らせなくても警告だけ出して続ける。これが無くても auto-programmer 自体は動くので、
//   メインループを止めてまで守る価値が無いベストエフォートの保険である（sleepGuard.mjs と同じ扱い）。
//   並べて動かした複数のプロセスの声が重なることは許す。
// - 声は指定せず、OS の既定の声に任せる。指定すると、その声が無い PC で鳴らなくなる。
// - Windows では、読む文を環境変数で渡し、`-Command` の文字列はタイトルによらず固定にする。タイトルは GitHub から来る
//   外部が書ける文字列で、`-Command` に埋め込むと、`"` や `;` を含むタイトルが PowerShell のコマンドとして実行されてしまう。
// - detached にするのは Ctrl+C 対策でもある。端末の Ctrl+C が読み上げの子プロセスにも届くと、締めの読み上げが途中で切れる。

import { spawn } from 'node:child_process'

import { STAGE_NUMBER_PATTERN } from './startOrder.mjs'
import { showWarning } from './ui.mjs'

// 親を実装していない回を、実装の完了と聞き違えないよう、子へ引き継いだ回には別の言葉を当てる
const RESULT_WORD_BY_RUN_OUTCOME = {
  failed: '失敗しました',
  'needs-human-attention': '要確認です',
  'handed-over-to-sub-issues': '子の issue に引き継ぎました',
  completed: '完了しました'
}

const WINDOWS_SPEECH_SENTENCE_ENV_NAME = 'AUTO_PROGRAMMER_SPEECH_SENTENCE'
const WINDOWS_SPEECH_SCRIPT = `Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak($Env:${WINDOWS_SPEECH_SENTENCE_ENV_NAME})`

/**
 * Issue 1件を終えたことと結果を、読み上げで知らせる。対象外の OS では何もしない。
 *
 * 読み上げの終わりを待たずに戻る。起動に失敗しても、起動した後に落ちても例外にせず、警告を1行表示する。
 *
 * @param {{ issueNumber: number, issueTitle: string, runOutcome: 'failed' | 'needs-human-attention' | 'handed-over-to-sub-issues' | 'completed' }} params 終えた Issue の番号とタイトル、締めの結果の分類（`runOutcome.mjs` の `decideRunOutcome` の戻り値）
 * @returns {void}
 */
export function speakIssueResult({ issueNumber, issueTitle, runOutcome }) {
  const sentence = buildSentence({
    issueNumber,
    resultWord: RESULT_WORD_BY_RUN_OUTCOME[runOutcome],
    issueTitle
  })
  const launch = resolveSpeechLaunch({ platform: process.platform, sentence })
  if (launch) launchSpeech(launch)
}

/**
 * 読む文を組み立てる。タイトル先頭の段番号は外す。
 *
 * 段番号を読むと「いち、」「いちからに、」が頭に入るだけで、Issue を聞き分ける手掛かりにならない。
 *
 * @param {{ issueNumber: number, resultWord: string, issueTitle: string }} params 番号・結果の言葉・タイトル
 * @returns {string} 読む文（`issue <番号>、<結果>。<段番号を外したタイトル>`）
 */
function buildSentence({ issueNumber, resultWord, issueTitle }) {
  return `issue ${issueNumber}、${resultWord}。${issueTitle.replace(STAGE_NUMBER_PATTERN, '')}`
}

/**
 * OS ごとに、読み上げコマンドの起動内容を決める。
 *
 * @param {{ platform: string, sentence: string }} params `process.platform` の値と、読む文
 * @returns {{ command: string, args: string[], env?: Record<string, string> } | null} 起動するコマンドと引数、親の環境変数に足す環境変数（対象外の OS なら null）
 */
function resolveSpeechLaunch({ platform, sentence }) {
  // 文は引数でそのまま渡す（シェルを通さないので、`"` や `;` を含んでもコマンドとして解釈されない）。
  // 先頭が `issue` なので、`say` のオプションと取り違えられない
  if (platform === 'darwin') return { command: 'say', args: [sentence] }
  if (platform === 'win32') {
    // `-Command` は最後の引数にする（後ろに続く引数は、すべて実行するコマンドの一部として解釈される）
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-Command', WINDOWS_SPEECH_SCRIPT],
      env: { [WINDOWS_SPEECH_SENTENCE_ENV_NAME]: sentence }
    }
  }
  return null
}

/**
 * 読み上げコマンドを detached で起動し、終わりを待たずに戻る。失敗は警告にして例外にしない。
 *
 * @param {{ command: string, args: string[], env?: Record<string, string> }} launch `resolveSpeechLaunch` が決めた起動内容
 * @returns {void}
 */
function launchSpeech(launch) {
  // 'error' の後に 'exit' が来るかは Node が保証しない。両方を受けるので、同じ失敗で警告を2回出さないよう1回に絞る
  let hasWarned = false
  const warnOnce = (message) => {
    if (hasWarned) return
    hasWarned = true
    showWarning(message)
  }
  try {
    const child = spawn(launch.command, launch.args, {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ...launch.env },
      // Windows で、読み上げのたびにコンソール窓が開くのを防ぐ（sleepGuard.mjs と同じ）
      windowsHide: true
    })
    // 'error' はリスナが無いと例外として投げられ、無人のメインループごと落としてしまう。
    // 読み上げコマンドが万一無くても、警告だけ出して続行する
    child.on('error', (error) => {
      warnOnce(`読み上げの起動に失敗しました（続行します）: ${error.message}`)
    })
    // stdio: 'ignore' なので、起動した後に落ちても出力が残らない。終了コードで知らせる
    child.on('exit', (exitCode, terminationSignal) => {
      if (exitCode === 0) return
      const cause = exitCode === null ? `シグナル ${terminationSignal}` : `終了コード ${exitCode}`
      warnOnce(`読み上げが途中で終わりました（${cause}で終了。続行します）`)
    })
    child.unref()
  } catch (error) {
    // 引数に spawn が受け付けない文字が含まれると、'error' ではなく同期的に投げられる
    warnOnce(`読み上げの起動に失敗しました（続行します）: ${error.message}`)
  }
}
