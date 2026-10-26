// 責務: commit に紐づく CI の run を gh で読む口を担う。いつ読むかは呼び出し側が決める。
//
// 設計意図（WHY）:
// - gh の引数と戻り値の読み方を、commit 1件単位の口としてここに置く。直すたびに、CI 待ちや実行記録の流れの混ざった
//   index.mjs を開かずに済む。
// - 中身を判断せず、gh が返した run の一覧をそのまま返す。run の状態の判定は ciRun.mjs が持つ。
// - 画面への表示は、1回引けなかったときの警告だけを持つ（tryListCiRuns）。この文面は、呼び出し側が引き直すことを
//   前提にする。引き直す間隔と最後の1回の扱いは、待ち時間と一緒に決まるため、呼び出し側が持つ。
// - 呼び出し側を import しない。呼び出し側からこのモジュールへの一方向にして、循環を作らない。

import { config } from './config.mjs'
import { CI_RUN_STATE_FIELDS } from './ciRun.mjs'
import { runJson } from './shell.mjs'
import { showWarning } from './ui.mjs'
import { formatErrorMessage } from './uiFormat.mjs'

/**
 * commit に紐づく CI の run を一覧で引く。
 *
 * @param {string} headSha commit の SHA
 * @returns {{ databaseId: number, status: string, conclusion: string, headSha: string, url: string }[]} run の一覧
 * @throws {Error} gh が失敗したとき
 */
export function listCiRuns(headSha) {
  // --branch は付けない。--commit と併せると、該当する run があっても空で返る
  return runJson('gh', [
    'run',
    'list',
    '--repo',
    config.repository,
    '--workflow',
    config.ci.workflowFile,
    '--commit',
    headSha,
    '--json',
    CI_RUN_STATE_FIELDS
  ])
}

/**
 * commit の CI の run を1回引く。失敗しても投げず、理由を出して null を返す。
 * 警告に「引き直します」と出すので、null を受けたら引き直す呼び出し側だけが使う。
 *
 * @param {string} headSha 引く commit の SHA
 * @returns {ReturnType<typeof listCiRuns> | null} run の一覧（引けなければ null）
 */
export function tryListCiRuns(headSha) {
  try {
    return listCiRuns(headSha)
  } catch (error) {
    showWarning(`CI の run を引けませんでした。引き直します: ${formatErrorMessage(error)}`)
    return null
  }
}
