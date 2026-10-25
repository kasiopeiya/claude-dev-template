// 責務: 作業ツリーのファイルを検査する3本（check-claude-md-size・check-rule-size・check-markdown-links）が、
//   作業中のファイルの状態（新規・削除・日本語名）に左右されず検査できることを守る。
//   ターン末ゲートは作業中の変更を検査するため、ここが崩れるとゲートが素通りするか、スタックトレースで落ちる。

import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

import {
  commitAll,
  createRepositoryWithCiScripts,
  removeTemporaryDirectories,
  runCiScript,
  writeRepositoryFile
} from './ciScriptHarness.mjs'

after(removeTemporaryDirectories)

const OVERSIZED_CLAUDE_MD = 'あ'.repeat(7001)
const OVERSIZED_RULE = 'あ'.repeat(6001)

const SYNC_TEMPLATE_SCRIPT = `readonly EXCLUDE_PATHS=(
  'docs/adr/'
)
readonly EXCLUDE_EXCEPTIONS=(
  'docs/adr/adr-template.md'
)
`

/** 写したスクリプトを、リポジトリ直下を作業ディレクトリにして走らせる */
function runScript(repositoryRoot, scriptName) {
  return runCiScript({
    scriptPath: join(repositoryRoot, 'scripts/ci', scriptName),
    workingDirectory: repositoryRoot
  })
}

describe('CLAUDE.md の文字数検査（check-claude-md-size）', () => {
  const sut = (repositoryRoot) => runScript(repositoryRoot, 'check-claude-md-size.mjs')

  test('まだ追跡していない新しい CLAUDE.md も、上限を超えていれば落とす', () => {
    const repositoryRoot = createRepositoryWithCiScripts()
    writeRepositoryFile(repositoryRoot, 'CLAUDE.md', '短い')
    commitAll(repositoryRoot)
    writeRepositoryFile(repositoryRoot, 'docs/CLAUDE.md', OVERSIZED_CLAUDE_MD)

    const result = sut(repositoryRoot)

    assert.equal(result.status, 1)
    assert.match(result.stderr, /docs\/CLAUDE\.md: 7001 文字/)
  })

  test('追跡中の CLAUDE.md を作業ツリーで消しても、残りを検査して通る', () => {
    const repositoryRoot = createRepositoryWithCiScripts()
    writeRepositoryFile(repositoryRoot, 'CLAUDE.md', '短い')
    writeRepositoryFile(repositoryRoot, 'docs/CLAUDE.md', '短い')
    commitAll(repositoryRoot)
    rmSync(join(repositoryRoot, 'docs/CLAUDE.md'))

    const result = sut(repositoryRoot)

    assert.equal(result.status, 0)
    assert.match(result.stdout, /^CLAUDE\.md: 2 \/ 7000 文字$/m)
    assert.doesNotMatch(result.stdout, /docs\/CLAUDE\.md/)
  })

  test('日本語名のディレクトリにある CLAUDE.md も読んで、上限を超えていれば落とす', () => {
    const repositoryRoot = createRepositoryWithCiScripts()
    writeRepositoryFile(repositoryRoot, '日本語/CLAUDE.md', OVERSIZED_CLAUDE_MD)
    commitAll(repositoryRoot)

    const result = sut(repositoryRoot)

    assert.equal(result.status, 1)
    assert.match(result.stderr, /日本語\/CLAUDE\.md: 7001 文字/)
  })
})

describe('Rule の文字数検査（check-rule-size）', () => {
  const sut = (repositoryRoot) => runScript(repositoryRoot, 'check-rule-size.mjs')

  test('まだ追跡していない新しい Rule も、上限を超えていれば落とす', () => {
    const repositoryRoot = createRepositoryWithCiScripts()
    writeRepositoryFile(repositoryRoot, '.claude/rules/existing.md', '短い')
    commitAll(repositoryRoot)
    writeRepositoryFile(repositoryRoot, '.claude/rules/split-out.md', OVERSIZED_RULE)

    const result = sut(repositoryRoot)

    assert.equal(result.status, 1)
    assert.match(result.stderr, /\.claude\/rules\/split-out\.md: 6001 文字/)
  })

  test('追跡中の Rule を作業ツリーで消しても、残りを検査して通る', () => {
    const repositoryRoot = createRepositoryWithCiScripts()
    writeRepositoryFile(repositoryRoot, '.claude/rules/kept.md', '短い')
    writeRepositoryFile(repositoryRoot, '.claude/rules/gone.md', '短い')
    commitAll(repositoryRoot)
    rmSync(join(repositoryRoot, '.claude/rules/gone.md'))

    const result = sut(repositoryRoot)

    assert.equal(result.status, 0)
    assert.match(result.stdout, /^\.claude\/rules\/kept\.md: 2 \/ 6000 文字$/m)
    assert.doesNotMatch(result.stdout, /gone\.md/)
  })

  test('日本語名の Rule も読んで、上限を超えていれば落とす', () => {
    const repositoryRoot = createRepositoryWithCiScripts()
    writeRepositoryFile(repositoryRoot, '.claude/rules/日本語.md', OVERSIZED_RULE)
    commitAll(repositoryRoot)

    const result = sut(repositoryRoot)

    assert.equal(result.status, 1)
    assert.match(result.stderr, /\.claude\/rules\/日本語\.md: 6001 文字/)
  })
})

describe('Markdown の相対リンク検査（check-markdown-links）', () => {
  const sut = (repositoryRoot) => runScript(repositoryRoot, 'check-markdown-links.mjs')

  function createRepositoryWithSyncScript() {
    const repositoryRoot = createRepositoryWithCiScripts()
    writeRepositoryFile(repositoryRoot, 'scripts/sync-template.sh', SYNC_TEMPLATE_SCRIPT)
    return repositoryRoot
  }

  test('日本語名の Markdown も読んで、壊れたリンクを落とす', () => {
    const repositoryRoot = createRepositoryWithSyncScript()
    writeRepositoryFile(repositoryRoot, 'docs/手順.md', '[存在しない](./missing.md)\n')
    commitAll(repositoryRoot)

    const result = sut(repositoryRoot)

    assert.equal(result.status, 1)
    assert.match(result.stderr, /docs\/手順\.md:1 -> \.\/missing\.md/)
  })

  test('追跡中の Markdown を作業ツリーで消しても、残りを検査して通る', () => {
    const repositoryRoot = createRepositoryWithSyncScript()
    writeRepositoryFile(
      repositoryRoot,
      'README.md',
      '外部へのリンクだけ [x](https://example.com)\n'
    )
    writeRepositoryFile(repositoryRoot, 'docs/gone.md', '消す\n')
    commitAll(repositoryRoot)
    rmSync(join(repositoryRoot, 'docs/gone.md'))

    const result = sut(repositoryRoot)

    assert.equal(result.status, 0)
    assert.match(result.stdout, /Markdown 1 本の相対リンクはすべて実在し/)
  })
})
