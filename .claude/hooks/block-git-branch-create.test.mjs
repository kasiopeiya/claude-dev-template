// 責務: hook の配線（stdin から PreToolUse JSON を読み、permissionDecision: deny を stdout に返す）のみを検証する。
//
// 判定ロジックそのものは gitBranchCreationMatcher.test.mjs が担う。ここは「プロセスとして
// 起動して本当に発火するか」の end-to-end 配線だけを見る。

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const hook = resolve(scriptDir, 'block-git-branch-create.mjs')

// SUT: block-git-branch-create hook をサブプロセスとして起動し、stdout（判定結果）を返す。
// hook は作業をブロックしないため常に正常終了する契約であり、それを前提の不変条件として守る。
function runHook(toolInput) {
  const res = spawnSync('node', [hook], {
    input: JSON.stringify({ tool_input: toolInput }),
    encoding: 'utf8'
  })
  assert.equal(res.status, 0, `hook exited non-zero: ${res.stderr}`)
  return res.stdout
}

describe('block-git-branch-create hook の配線', () => {
  test('ブランチ作成コマンドには permissionDecision: deny を返す', () => {
    const out = runHook({ command: 'git checkout -b feature/foo' })

    const parsed = JSON.parse(out)
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse')
    assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny')
    assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /ブランチ/)
  })

  test('ブランチ作成でないコマンドには何も出力しない', () => {
    const out = runHook({ command: 'git branch -d old-branch' })

    assert.equal(out.trim(), '')
  })

  test('command が無ければ何も出力しない', () => {
    const out = runHook({})

    assert.equal(out.trim(), '')
  })
})
