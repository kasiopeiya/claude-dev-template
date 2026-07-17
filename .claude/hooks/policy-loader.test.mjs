// 責務: hook の配線（stdin から PreToolUse JSON を読み、hookSpecificOutput を stdout に返す）のみを検証する。
//
// マッチ判定そのものは policyMatcher.test.mjs が担う。ここは「プロセスとして起動して本当に
// 発火するか」の end-to-end 配線だけを見る。合成パスを1つ流し、出力の形だけを確かめる
// （実ファイルにも、返るポリシー名の期待表にも依存しない）。

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const loader = resolve(scriptDir, 'policy-loader.mjs')
const projectRoot = resolve(scriptDir, '../..')

// SUT: policy-loader hook をサブプロセスとして起動し、stdout（注入内容）を返す。
// hook は作業をブロックしないため常に正常終了する契約であり、それを前提の不変条件として守る。
function runHook(toolInput) {
  const res = spawnSync('node', [loader], {
    input: JSON.stringify({ tool_input: toolInput }),
    encoding: 'utf8'
  })
  assert.equal(res.status, 0, `hook exited non-zero: ${res.stderr}`)
  return res.stdout
}

describe('policy-loader hook の配線', () => {
  test('マッチするパスにはポリシー参照を hookSpecificOutput として返す', () => {
    // app 配下の .ts は application-* / code-comment ポリシーにマッチする（合成パス・実在不要）
    const out = runHook({ file_path: resolve(projectRoot, 'app/backend/__synthetic__.ts') })

    const parsed = JSON.parse(out)
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse')
    assert.match(parsed.hookSpecificOutput.additionalContext, /docs\/policy\//)
  })

  test('マッチしないパスには何も出力しない', () => {
    const out = runHook({ file_path: resolve(projectRoot, 'no/such/area/file.xyz') })

    assert.equal(out.trim(), '')
  })

  test('file_path が無ければ何も出力しない', () => {
    const out = runHook({})

    assert.equal(out.trim(), '')
  })
})
