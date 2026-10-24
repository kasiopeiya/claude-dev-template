// 責務: Issue 1件ぶんの実行結果を1行の JSON として追記し、追記した記録を読み出す。
//
// 設計意図（WHY）:
// - 無人で走るツールなので、端末を閉じた後に「いつ・どの Issue を・どうなったか」を確かめる手段が
//   要る。1行1件の JSON Lines にしておけば、後から grep でも jq でも読める。
// - 記録は、このツールが作った PR を見分ける唯一の手がかりでもある。衝突した PR を解かせる対象は、記録に URL が残る PR に限る
//   （conflictedPullRequest.mjs）。

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { config } from './config.mjs'

/**
 * 実行結果を記録ファイルへ1行追記する。
 *
 * @param {Record<string, unknown>} record 記録する内容（Issue 番号・ブランチ・終了状態・PR の URL・時刻など）
 * @returns {void}
 */
export function recordRun(record) {
  mkdirSync(dirname(config.runLogPath), { recursive: true })
  appendFileSync(config.runLogPath, `${JSON.stringify(record)}\n`)
}

/**
 * 記録ファイルの中身を読む。
 *
 * @returns {string} 記録ファイルの中身（まだ1件も記録していなければ空文字）
 * @throws {Error} 記録ファイルがあるのに読めなかったとき
 */
function readRunLogText() {
  try {
    return readFileSync(config.runLogPath, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return ''
    throw error
  }
}

/**
 * 記録の1行を読む。
 *
 * @param {string} line 記録の1行
 * @returns {Record<string, unknown>[]} 読めた記録1件だけの配列（JSON のオブジェクトとして読めなければ空）
 */
function parseRunLogLine(line) {
  try {
    const runRecord = JSON.parse(line)
    return runRecord !== null && typeof runRecord === 'object' ? [runRecord] : []
  } catch {
    return []
  }
}

/**
 * 記録ファイルの全件を古い順に読む。
 *
 * 並べたプロセスが同じファイルへ追記するので、書きかけの行が混ざりうる。読めない行は飛ばす。
 *
 * @returns {Record<string, unknown>[]} 記録（まだ1件も記録していなければ空）
 * @throws {Error} 記録ファイルがあるのに読めなかったとき
 */
export function readRunRecords() {
  return readRunLogText().split('\n').flatMap(parseRunLogLine)
}
