// 責務: Issue 1件ぶん（または衝突した PR 1件ぶん）の作業を走らせ、途中で落ちても結果を記録し、締めを画面に出す。
//
// 設計意図（WHY）:
// - Issue の実装と、衝突を解かせる処理の両方が同じ記録の決まりに従うので、入口の index.mjs にも conflictResolution.mjs にも置かず、
//   両方が import する下位のモジュールにする。呼び出し側を import しない。呼び出し側からこのモジュールへの一方向にして、循環を作らない。
// - 予定した終わり方以外で終えた回は、記録の前に `needs-human-check` を付ける（どれを予定とするかは needsHumanCheck.mjs。Issue #1000）。
//   付けるのはここと、シグナルで終わる直前（stopSignals.mjs のリスナ）の2か所だけにする。止まり方ごとに付けると、例外で落ちた経路が付け漏れる。

import { config } from './config.mjs'
import { tryMarkAsNeedsHumanCheck } from './issueWrite.mjs'
import { shouldMarkAsNeedsHumanCheck } from './needsHumanCheck.mjs'
import { recordRun } from './runLog.mjs'
import { decideRunOutcome } from './runOutcome.mjs'
import { clearInFlightIssueNumber, setInFlightIssueNumber } from './stopSignals.mjs'
import { showError, showInfo, showSuccess, showWarning } from './ui.mjs'
import {
  alignLabeledValues,
  collapseToSingleLine,
  formatElapsedTime,
  formatErrorMessage,
  formatErrorWithStack
} from './uiFormat.mjs'

/**
 * Issue 1件ぶんの作業を走らせ、途中で落ちても結果を記録する。予定した終わり方以外で終えたら、記録の前に `needs-human-check` を付ける
 * （付けられなくても投げない）。
 *
 * @param {{ record: Record<string, unknown> & { issueNumber: number }, runWork: (record: Record<string, unknown>, workStartedAt: string) => Promise<boolean>, readPullRequestUrl: () => string | null, speakRunOutcome?: (runOutcome: 'failed' | 'needs-human-attention' | 'handed-over-to-sub-issues' | 'completed') => void }} params 記録の初期値・作業（受け取った記録へ結果を書き足し、作業を始めた時刻（ISO 8601。記録の `sessionStartedAt` と同じ値）を受け取り、走らせた claude セッションがすべて正常終了したら true を返す）・記録に残す PR の URL を引く関数（作業の後に呼ぶ）・締めの結果の分類を読み上げる関数（画面の締めの後に呼ぶ。省けば読み上げない）
 * @returns {Promise<boolean>} 走らせた claude セッションがすべて正常終了したら true（起動できなかった・打ち切られた・0 以外で終わった・途中で例外が出たら false）
 * @throws {Error} 記録ファイルへ書けなかったとき
 */
export async function runWorkAndRecord({ record, runWork, readPullRequestUrl, speakRunOutcome }) {
  const workStartedAt = new Date().toISOString()
  record.sessionStartedAt = workStartedAt
  setInFlightIssueNumber(record.issueNumber)
  let isAllSessionsSucceeded = false
  try {
    isAllSessionsSucceeded = await runWork(record, workStartedAt)
  } catch (error) {
    // 無人実行の画面はセッションの出力で流れるため、スタックを出すと原因の1行が埋もれる（Issue #780）
    record.error = formatErrorMessage(error)
    record.errorStack = formatErrorWithStack(error)
    showError(`#${record.issueNumber} の処理が落ちました: ${collapseToSingleLine(record.error)}`)
  } finally {
    record.pullRequestUrl = readPullRequestUrl()
    record.finishedAt = new Date().toISOString()
    if (shouldMarkAsNeedsHumanCheck(record, isAllSessionsSucceeded)) {
      Object.assign(record, tryMarkAsNeedsHumanCheck(record.issueNumber))
    }
    recordRun(record)
    clearInFlightIssueNumber()
    const runOutcome = decideRunOutcome(record, isAllSessionsSucceeded)
    showRunSummary(record, runOutcome)
    speakRunOutcome?.(runOutcome)
  }
  return isAllSessionsSucceeded
}

/**
 * Issue 1件の締めとして、所要時間・CI の結果・PR・記録先をまとめて表示する。
 *
 * 締めの記号は、結果の分類（decideRunOutcome）で決める。✗ は失敗、⚠ は人間の手当てが要る回、それ以外は ✓ である。
 *
 * @param {{ issueNumber: number, sessionStartedAt: string, finishedAt: string, pullRequestUrl: string | null, ciOutcome?: string, isCiPassed?: boolean, isClosedWithoutChanges?: boolean }} record 記録した内容
 * @param {'failed' | 'needs-human-attention' | 'handed-over-to-sub-issues' | 'completed'} runOutcome decideRunOutcome が決めた結果の分類
 * @returns {void}
 */
function showRunSummary(record, runOutcome) {
  const elapsedTime = formatElapsedTime(
    Date.parse(record.finishedAt) - Date.parse(record.sessionStartedAt)
  )
  const headline = `#${record.issueNumber} を終えました（${elapsedTime}）`
  if (runOutcome === 'failed') showError(headline)
  else if (runOutcome === 'needs-human-attention') showWarning(headline)
  else showSuccess(headline)

  // 値が同じ桁から始まるよう、項目名の幅を揃えてから行ごとのレベルで出す
  /* eslint-disable id-denylist -- { label, value } は「項目名と値の組」で、value が正しい語（#900） */
  const details = []
  if (record.ciOutcome) {
    details.push({
      label: 'CI',
      value: record.ciOutcome,
      show: record.isCiPassed || record.isClosedWithoutChanges ? showInfo : showWarning
    })
  }
  if (record.pullRequestUrl === null) {
    details.push({ label: 'PR', value: '有無は GitHub で確かめてください', show: showWarning })
  } else {
    details.push({
      label: 'PR',
      value: record.pullRequestUrl || '作られませんでした',
      show: showInfo
    })
  }
  details.push({ label: '記録', value: config.runLogPath, show: showInfo })
  /* eslint-enable id-denylist */
  const lines = alignLabeledValues(details)
  details.forEach(({ show }, index) => show(lines[index]))
}
