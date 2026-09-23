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

// hook.applies-to は名指しのパスへの編集時注入用の経路であり、paths と異なり対象ファイルの
// 有無にかかわらず常に案内する。実在する Rule には依存せず、都度合成した Rule ファイルで検証する。
describe('policy-loader hook の Rule 肩代わり（hook.applies-to）', () => {
  function writeSyntheticRule(ruleFileName, ruleFrontmatterBody) {
    const ruleFilePath = resolve(projectRoot, '.claude/rules', ruleFileName)
    writeFileSync(ruleFilePath, `---\n${ruleFrontmatterBody}\n---\n\n# 合成テスト用 Rule\n`)
    return ruleFilePath
  }

  test('hook.applies-to が合う対象は、ファイルが存在しても案内する', () => {
    const ruleFileName = '__synthetic_applies_to_existing__.md'
    const targetFilePath = resolve(projectRoot, 'tmp/__synthetic_applies_to_existing_target__.md')
    const ruleFilePath = writeSyntheticRule(
      ruleFileName,
      "hook:\n  applies-to: ['tmp/__synthetic_applies_to_existing_target__.md']"
    )
    mkdirSync(dirname(targetFilePath), { recursive: true })
    writeFileSync(targetFilePath, '')

    try {
      const hookOutput = runHook({ file_path: targetFilePath })

      assert.match(hookOutput, new RegExp(`\\.claude/rules/${ruleFileName}`))
    } finally {
      rmSync(ruleFilePath, { force: true })
      rmSync(targetFilePath, { force: true })
    }
  })

  test('hook.applies-to が合う対象は、ファイルが存在しなくても案内する', () => {
    const ruleFileName = '__synthetic_applies_to_missing__.md'
    const targetFilePath = resolve(projectRoot, 'tmp/__synthetic_applies_to_missing_target__.md')
    const ruleFilePath = writeSyntheticRule(
      ruleFileName,
      "hook:\n  applies-to: ['tmp/__synthetic_applies_to_missing_target__.md']"
    )

    try {
      const hookOutput = runHook({ file_path: targetFilePath })

      assert.match(hookOutput, new RegExp(`\\.claude/rules/${ruleFileName}`))
    } finally {
      rmSync(ruleFilePath, { force: true })
    }
  })

  test('paths と hook.applies-to の両方に合う Rule は、一覧に一度だけ出す', () => {
    const ruleFileName = '__synthetic_both_match__.md'
    const targetFilePath = resolve(projectRoot, 'tmp/__synthetic_both_match_target__.md')
    const ruleFilePath = writeSyntheticRule(
      ruleFileName,
      "paths:\n  - 'tmp/__synthetic_both_match_target__.md'\nhook:\n  applies-to: ['tmp/__synthetic_both_match_target__.md']"
    )

    try {
      const hookOutput = runHook({ file_path: targetFilePath })

      const occurrences = hookOutput.split(`.claude/rules/${ruleFileName}`).length - 1
      assert.equal(occurrences, 1)
    } finally {
      rmSync(ruleFilePath, { force: true })
    }
  })
})
