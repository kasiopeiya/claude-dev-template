// 責務: Issue へのコメントとラベルの書き込みを gh で行う口を担う。どの Issue にいつ何を書くか（コメントの本文を含む）・書いた結果で何をするかは呼び出し側が決める。
//
// 設計意図（WHY）:
// - gh の引数とラベル名の扱いを、Issue 1件への書き込み単位の口としてここに置く。直すたびに、CI 待ちや実行記録の混ざった
//   index.mjs を開かずに済む。
// - 書き込みの失敗は、投げて呼び出し側に任せる。例外は tryMarkAsNeedsHumanCheck だけで、シグナルのリスナと記録の finally から
//   呼ばれ、投げると記録が残らず終了にも至らないため、失敗を戻り値で返す。
// - 画面への表示は、tryMarkAsNeedsHumanCheck が付けられなかったときの警告1行だけを持つ。投げずに握る代わりに、
//   握った事実をその場で見せる必要があるため。それ以外の表示する文面は、呼び出された場面で決まるので呼び出し側が持つ。
// - コメントの本文は決めず、渡された文字列をそのまま書く。文面は書く場面の知識に属するので、ここで決めると、
//   場面ごとの文面や、文面に入れる設定を変えるたびに、このモジュールまで直すことになる。
// - 呼び出し側を import しない。呼び出し側からこのモジュールへの一方向にして、循環を作らない。

import { config } from './config.mjs'
import { NEEDS_HUMAN_CHECK_LABEL } from './needsHumanCheck.mjs'
import { runOrThrow } from './shell.mjs'
import { showWarning } from './ui.mjs'
import { collapseToSingleLine, formatErrorMessage } from './uiFormat.mjs'

/**
 * Issue に、受け取った本文をコメントする。ラベルは付けない。
 *
 * @param {number} issueNumber 対象 Issue の番号
 * @param {string} body コメントの本文
 * @returns {void}
 * @throws {Error} gh が失敗したとき
 */
export function commentOnIssue(issueNumber, body) {
  runOrThrow('gh', [
    'issue',
    'comment',
    String(issueNumber),
    '--repo',
    config.repository,
    '--body',
    body
  ])
}

/**
 * Issue から `needs-human-check` を外す。付いていなくても失敗しない（付いているかを確かめずに呼べる）。
 *
 * @param {number} issueNumber 対象 Issue の番号
 * @returns {void}
 * @throws {Error} gh が失敗したとき
 */
export function removeNeedsHumanCheckLabel(issueNumber) {
  runOrThrow('gh', [
    'issue',
    'edit',
    String(issueNumber),
    '--repo',
    config.repository,
    '--remove-label',
    NEEDS_HUMAN_CHECK_LABEL
  ])
}

/**
 * Issue に `needs-human-check` を付ける。付けられなくても投げない。
 *
 * @param {number} issueNumber 対象 Issue の番号
 * @returns {{ isMarkedAsNeedsHumanCheck: true } | { isMarkedAsNeedsHumanCheck: false, needsHumanCheckLabelError: string }} 付けられたかと、付けられなかったときの理由（記録へ書き足す）
 */
export function tryMarkAsNeedsHumanCheck(issueNumber) {
  try {
    runOrThrow('gh', [
      'issue',
      'edit',
      String(issueNumber),
      '--repo',
      config.repository,
      '--add-label',
      NEEDS_HUMAN_CHECK_LABEL
    ])
    return { isMarkedAsNeedsHumanCheck: true }
  } catch (error) {
    const needsHumanCheckLabelError = formatErrorMessage(error)
    showWarning(
      `#${issueNumber} に ${NEEDS_HUMAN_CHECK_LABEL} を付けられませんでした: ${collapseToSingleLine(needsHumanCheckLabelError)}`
    )
    return { isMarkedAsNeedsHumanCheck: false, needsHumanCheckLabelError }
  }
}
