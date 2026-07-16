// 責務: hook の配線（stdin から PreToolUse JSON を読み、hookSpecificOutput を stdout に返す）のみを検証する。
//
// マッチ判定そのものは policyMatcher.test.mjs が担う。ここは「プロセスとして起動して本当に
// 発火するか」の end-to-end 配線だけを見る。合成パスを1つ流し、出力の形だけを確かめる
// （実ファイルにも、返るポリシー名の期待表にも依存しない）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const loader = resolve(scriptDir, 'policy-loader.mjs')
const projectRoot = resolve(scriptDir, '../..')

function runHook(filePath) {
  const input = JSON.stringify({ tool_input: { file_path: filePath } })
  const res = spawnSync('node', [loader], { input, encoding: 'utf8' })
  assert.equal(res.status, 0, `hook exited non-zero: ${res.stderr}`)
  return res.stdout
}

test('マッチするパスに対し hookSpecificOutput を JSON で返す', () => {
  // app 配下の .ts は application-* / code-comment ポリシーにマッチする（合成パス・実在不要）
  const out = runHook(resolve(projectRoot, 'app/backend/__synthetic__.ts'))
  const parsed = JSON.parse(out)
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse')
  assert.match(parsed.hookSpecificOutput.additionalContext, /docs\/policy\//)
})

test('マッチしないパスには何も出力しない', () => {
  const out = runHook(resolve(projectRoot, 'no/such/area/file.xyz'))
  assert.equal(out.trim(), '')
})

test('file_path が無ければ何も出力せず正常終了する', () => {
  const res = spawnSync('node', [loader], {
    input: JSON.stringify({ tool_input: {} }),
    encoding: 'utf8'
  })
  assert.equal(res.status, 0)
  assert.equal(res.stdout.trim(), '')
})
