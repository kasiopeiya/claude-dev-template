// 責務: hook の配線（stdin から PreToolUse JSON を読み、hookSpecificOutput を stdout に返す）、
// 照合に使う相対パスへの変換（別フォルダの worktree・別リポジトリ・git に問い合わせられないとき）、
// 対象ファイルの実在で Rule を指すかの切り替えを、プロセスとして起動して検証する。
//
// マッチ判定そのものは policyMatcher.test.mjs が担う（ruleMatcher.mjs・projectRelativePath.mjs は
// unit-test-policy の例外一覧に無いため、ここでの end-to-end 検証だけでカバーする）。返るポリシー名・Rule 名の
// 期待表には依存しない。

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const loaderScriptPath = resolve(scriptDir, 'policy-loader.mjs')
const projectRoot = resolve(scriptDir, '../..')
const HOOK_TIMEOUT_MS = 5000

// SUT: policy-loader hook をサブプロセスとして起動し、stdout（注入内容）を返す。
// hook は作業をブロックしないため常に正常終了する契約であり、それを前提の不変条件として守る。
function runHook(toolInput, env = process.env) {
  const hookProcess = spawnSync('node', [loaderScriptPath], {
    input: JSON.stringify({ tool_input: toolInput }),
    encoding: 'utf8',
    timeout: HOOK_TIMEOUT_MS,
    env
  })
  assert.equal(hookProcess.status, 0, `hook exited non-zero: ${hookProcess.stderr}`)
  return hookProcess.stdout
}

// テストの準備に使う git を実行する。準備の失敗を hook の不具合と取り違えないよう、ここで止める
function runGitForArrange(gitArguments, workingDirectory) {
  const gitProcess = spawnSync('git', gitArguments, { cwd: workingDirectory, encoding: 'utf8' })
  assert.equal(gitProcess.status, 0, `git ${gitArguments[0]} failed: ${gitProcess.stderr}`)
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

  test('別フォルダの worktree のパスにも、同じ相対パスと同じ指し示しを返す', () => {
    const targetRelativePath = 'scripts/__synthetic__.mjs'
    const hookOutputInProject = runHook({ file_path: resolve(projectRoot, targetRelativePath) })
    // hook からの相対パスが .. で始まる状況を再現するため、置き場所の外に worktree を作る。
    // 展開を省くのは、検証に使うのがパスだけでファイルの実在は要らないため
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'policy-loader-'))
    const worktreePath = join(temporaryDirectory, 'worktree')

    // 準備の失敗でも一時ディレクトリを片付けるため、worktree の作成から try に入れる
    try {
      runGitForArrange(
        ['worktree', 'add', '--quiet', '--detach', '--no-checkout', worktreePath],
        projectRoot
      )

      const hookOutputInWorktree = runHook({ file_path: join(worktreePath, targetRelativePath) })

      assert.match(hookOutputInWorktree, /docs\/policy\//)
      assert.equal(hookOutputInWorktree, hookOutputInProject)
    } finally {
      spawnSync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: projectRoot })
      rmSync(temporaryDirectory, { recursive: true, force: true })
    }
  })

  test('別リポジトリのパスには何も出力しない', () => {
    const otherRepositoryPath = mkdtempSync(join(tmpdir(), 'policy-loader-other-repository-'))

    try {
      runGitForArrange(['init', '--quiet'], otherRepositoryPath)

      const hookOutput = runHook({ file_path: join(otherRepositoryPath, 'app/backend/x.ts') })

      assert.equal(hookOutput.trim(), '')
    } finally {
      rmSync(otherRepositoryPath, { recursive: true, force: true })
    }
  })

  test('git に問い合わせられないときも、プロジェクト内のパスにはポリシー参照を返す', () => {
    const gitUnavailableEnv = { ...process.env, GIT_DIR: join(tmpdir(), '__no_such_git_dir__') }

    const hookOutput = runHook(
      { file_path: resolve(projectRoot, 'app/backend/__synthetic__.ts') },
      gitUnavailableEnv
    )

    assert.match(hookOutput, /「app\/backend\/__synthetic__\.ts」/)
    assert.match(hookOutput, /docs\/policy\//)
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
