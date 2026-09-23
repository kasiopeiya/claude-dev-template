// 責務: hook の配線（stdin から PreToolUse JSON を読み、hookSpecificOutput を stdout に返す）と、
// 対象ファイルの実在で Rule を指すかが切り替わることを、プロセスとして起動して検証する。
//
// マッチ判定そのものは policyMatcher.test.mjs が担う（ruleMatcher.mjs は unit-test-policy の
// 例外一覧に無いため、ここでの end-to-end 検証だけでカバーする）。返るポリシー名・Rule 名の
// 期待表には依存しない。

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const loaderScriptPath = resolve(scriptDir, 'policy-loader.mjs')
const projectRoot = resolve(scriptDir, '../..')
const HOOK_TIMEOUT_MS = 5000

// SUT: policy-loader hook をサブプロセスとして起動し、stdout（注入内容）を返す。
// hook は作業をブロックしないため常に正常終了する契約であり、それを前提の不変条件として守る。
function runHook(toolInput) {
  const hookProcess = spawnSync('node', [loaderScriptPath], {
    input: JSON.stringify({ tool_input: toolInput }),
    encoding: 'utf8',
    timeout: HOOK_TIMEOUT_MS
  })
  assert.equal(hookProcess.status, 0, `hook exited non-zero: ${hookProcess.stderr}`)
  return hookProcess.stdout
}

describe('policy-loader hook の配線', () => {
  test('マッチするパスにはポリシー参照を hookSpecificOutput として返す', () => {
    // app 配下の .ts には何らかのポリシーが掛かる（合成パス・実在不要）
    const hookOutput = runHook({ file_path: resolve(projectRoot, 'app/backend/__synthetic__.ts') })

    const parsedOutput = JSON.parse(hookOutput)
    assert.equal(parsedOutput.hookSpecificOutput.hookEventName, 'PreToolUse')
    assert.match(parsedOutput.hookSpecificOutput.additionalContext, /docs\/policy\//)
  })

  test('マッチしないパスには何も出力しない', () => {
    const hookOutput = runHook({ file_path: resolve(projectRoot, 'no/such/area/file.xyz') })

    assert.equal(hookOutput.trim(), '')
  })

  test('プロジェクト外のパスには何も出力しない', () => {
    const hookOutput = runHook({
      file_path: resolve(projectRoot, '../__outside_project__/app/backend/x.ts')
    })

    assert.equal(hookOutput.trim(), '')
  })

  test('file_path が無ければ何も出力しない', () => {
    const hookOutput = runHook({})

    assert.equal(hookOutput.trim(), '')
  })
})

// 対象ファイルが存在しないときだけ Rule を指す（既存ファイルは Read 時に標準ロード済み）。
describe('policy-loader hook の Rule 肩代わり', () => {
  test('存在しない .ts ファイルには Rule も指し示す', () => {
    const hookOutput = runHook({ file_path: resolve(projectRoot, 'app/backend/__synthetic__.ts') })

    assert.match(hookOutput, /\.claude\/rules\//)
  })

  test('存在する .ts ファイルには Rule を指し示さない', () => {
    const existingTargetFilePath = resolve(projectRoot, 'tmp/__policy_loader_test__.ts')
    mkdirSync(dirname(existingTargetFilePath), { recursive: true })
    writeFileSync(existingTargetFilePath, '')

    try {
      const hookOutput = runHook({ file_path: existingTargetFilePath })

      assert.doesNotMatch(hookOutput, /\.claude\/rules\//)
    } finally {
      rmSync(existingTargetFilePath, { force: true })
    }
  })
})
