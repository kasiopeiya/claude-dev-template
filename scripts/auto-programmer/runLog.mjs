// 責務: Issue 1件ぶんの実行結果を1行の JSON として追記する。
//
// 設計意図（WHY）:
// - 無人で走るツールなので、端末を閉じた後に「いつ・どの Issue を・どうなったか」を確かめる手段が
//   要る。1行1件の JSON Lines にしておけば、後から grep でも jq でも読める。

import { appendFileSync, mkdirSync } from 'node:fs'
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
