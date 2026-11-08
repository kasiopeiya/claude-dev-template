// 責務: hook の配線（stdin から PreToolUse JSON を読み、hookSpecificOutput を stdout に返す）、
// 照合に使う相対パスへの変換（別フォルダの worktree・別リポジトリ・git に問い合わせられないとき）、
// ポリシー・Rule を読む作業ツリー（別フォルダの worktree では、その worktree 側）、
// 対象ファイルの実在で Rule を指すかの切り替えを、プロセスとして起動して検証する。
//
// マッチ判定そのものは policyMatcher.test.mjs が担う（ruleMatcher.mjs・projectRelativePath.mjs は
// unit-test-policy の例外一覧に無いため、ここでの end-to-end 検証だけでカバーする）。返るポリシー名・Rule 名の
// 期待表には依存しない。

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const loaderScriptPath = resolve(scriptDir, 'policy-loader.mjs')
const projectRoot = resolve(scriptDir, '../..')
const HOOK_TIMEOUT_MS = 5000

// SUT: policy-loader hook をサブプロセスとして起動し、stdout（注入内容）を返す。
// hook は作業をブロックしないため常に正常終了する契約であり、それを前提の不変条件として守る。
function runHook(toolInput, env = process.env, hookScriptPath = loaderScriptPath) {
  const hookProcess = spawnSync('node', [hookScriptPath], {
    input: JSON.stringify({ tool_input: toolInput }),
    encoding: 'utf8',
    timeout: HOOK_TIMEOUT_MS,
    env
  })
  assert.equal(hookProcess.status, 0, `hook exited non-zero: ${hookProcess.stderr}`)
  return hookProcess.stdout
}

// テストの準備に使う git を実行する。準備の失敗を hook の不具合と取り違えないよう、ここで止める。
// GIT_INDEX_FILE などが git の hook 経由で引き継がれると、合成したリポジトリの代わりに呼び出し元の
// リポジトリを書き換えてしまうため、GIT_ で始まる環境変数は渡さない
function runGitForArrange(gitArguments, workingDirectory) {
  const environmentWithoutGit = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))
  )
  const gitProcess = spawnSync('git', gitArguments, {
    cwd: workingDirectory,
    encoding: 'utf8',
    env: environmentWithoutGit
  })
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

// 実在するポリシー・Rule に依存させないため、hook のコードだけを写した空のリポジトリ（元のフォルダ）と、
// その別フォルダの worktree を合成して検証する。ポリシー・Rule は都度合成したファイルだけを置く。
const SYNTHETIC_TARGET_RELATIVE_PATH = 'scripts/__synthetic__.mjs'
const ORIGINAL_POLICY_FILE_NAME = '__synthetic_original_policy__.md'

function writeSyntheticDocument(documentFilePath, appliesToGlob) {
  mkdirSync(dirname(documentFilePath), { recursive: true })
  writeFileSync(
    documentFilePath,
    `---\nhook:\n  applies-to: ['${appliesToGlob}']\n---\n\n# 合成テスト用の文書\n`
  )
}

// 元のフォルダには `scripts/**` に掛かるポリシーを1件だけ置いてコミットし、worktree はその
// コミットから展開する。後始末は cleanup で行う
function createSyntheticProject() {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'policy-loader-project-'))
  const originalFolder = join(temporaryDirectory, 'original')
  const worktreeFolder = join(temporaryDirectory, 'worktree')
  const cleanup = () => rmSync(temporaryDirectory, { recursive: true, force: true })

  // 準備の失敗でも一時ディレクトリを片付けるため、作成の全体を try に入れる
  try {
    mkdirSync(originalFolder)
    runGitForArrange(['init', '--quiet'], originalFolder)
    cpSync(scriptDir, join(originalFolder, '.claude/hooks'), { recursive: true })
    writeSyntheticDocument(
      join(originalFolder, 'docs/policy', ORIGINAL_POLICY_FILE_NAME),
      'scripts/**'
    )
    runGitForArrange(['add', '--all'], originalFolder)
    runGitForArrange(
      [
        '-c',
        'user.name=policy-loader-test',
        '-c',
        'user.email=policy-loader-test@example.invalid',
        'commit',
        '--quiet',
        '--no-verify',
        '--no-gpg-sign',
        '--message',
        'init'
      ],
      originalFolder
    )
    runGitForArrange(['worktree', 'add', '--quiet', '--detach', worktreeFolder], originalFolder)
  } catch (error) {
    cleanup()
    throw error
  }
  return {
    originalFolder,
    worktreeFolder,
    hookScriptPath: join(originalFolder, '.claude/hooks/policy-loader.mjs'),
    cleanup
  }
}

describe('policy-loader hook が読むポリシー・Rule の置き場所（別フォルダの worktree）', () => {
  test('書き換えていない worktree のファイルには、元のフォルダの同じファイルと同じ指し示しを返す', () => {
    const project = createSyntheticProject()

    try {
      const hookOutputInOriginal = runHook(
        { file_path: join(project.originalFolder, SYNTHETIC_TARGET_RELATIVE_PATH) },
        process.env,
        project.hookScriptPath
      )

      const hookOutputInWorktree = runHook(
        { file_path: join(project.worktreeFolder, SYNTHETIC_TARGET_RELATIVE_PATH) },
        process.env,
        project.hookScriptPath
      )

      assert.match(hookOutputInWorktree, new RegExp(`docs/policy/${ORIGINAL_POLICY_FILE_NAME}`))
      assert.equal(hookOutputInWorktree, hookOutputInOriginal)
    } finally {
      project.cleanup()
    }
  })

  test('worktree で applies-to から外したポリシーは、worktree のファイルに指し示さない', () => {
    const project = createSyntheticProject()

    try {
      writeSyntheticDocument(
        join(project.worktreeFolder, 'docs/policy', ORIGINAL_POLICY_FILE_NAME),
        'docs/**'
      )

      const hookOutputInWorktree = runHook(
        { file_path: join(project.worktreeFolder, SYNTHETIC_TARGET_RELATIVE_PATH) },
        process.env,
        project.hookScriptPath
      )

      assert.equal(hookOutputInWorktree.trim(), '')
    } finally {
      project.cleanup()
    }
  })

  test('worktree で applies-to に足したポリシーは、worktree のファイルに指し示す', () => {
    const addedPolicyFileName = '__synthetic_added_policy__.md'
    const project = createSyntheticProject()

    try {
      writeSyntheticDocument(
        join(project.worktreeFolder, 'docs/policy', addedPolicyFileName),
        'scripts/**'
      )

      const hookOutputInWorktree = runHook(
        { file_path: join(project.worktreeFolder, SYNTHETIC_TARGET_RELATIVE_PATH) },
        process.env,
        project.hookScriptPath
      )

      assert.match(hookOutputInWorktree, new RegExp(`docs/policy/${addedPolicyFileName}`))
    } finally {
      project.cleanup()
    }
  })

  test('worktree にだけある Rule（hook.applies-to）を、worktree のファイルに指し示す', () => {
    const worktreeRuleFileName = '__synthetic_worktree_rule__.md'
    const project = createSyntheticProject()

    try {
      writeSyntheticDocument(
        join(project.worktreeFolder, '.claude/rules', worktreeRuleFileName),
        'scripts/**'
      )

      const hookOutputInWorktree = runHook(
        { file_path: join(project.worktreeFolder, SYNTHETIC_TARGET_RELATIVE_PATH) },
        process.env,
        project.hookScriptPath
      )

      assert.match(hookOutputInWorktree, new RegExp(`\\.claude/rules/${worktreeRuleFileName}`))
    } finally {
      project.cleanup()
    }
  })

  test('worktree での applies-to の書き換えは、元のフォルダのファイルへの指し示しを変えない', () => {
    const addedPolicyFileName = '__synthetic_added_policy__.md'
    const project = createSyntheticProject()

    try {
      writeSyntheticDocument(
        join(project.worktreeFolder, 'docs/policy', ORIGINAL_POLICY_FILE_NAME),
        'docs/**'
      )
      writeSyntheticDocument(
        join(project.worktreeFolder, 'docs/policy', addedPolicyFileName),
        'scripts/**'
      )

      const hookOutputInOriginal = runHook(
        { file_path: join(project.originalFolder, SYNTHETIC_TARGET_RELATIVE_PATH) },
        process.env,
        project.hookScriptPath
      )

      assert.match(hookOutputInOriginal, new RegExp(`docs/policy/${ORIGINAL_POLICY_FILE_NAME}`))
      assert.doesNotMatch(hookOutputInOriginal, new RegExp(addedPolicyFileName))
    } finally {
      project.cleanup()
    }
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
