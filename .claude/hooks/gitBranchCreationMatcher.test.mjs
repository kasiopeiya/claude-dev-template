// 責務: detectGitBranchCreation の判定ロジックを合成入力だけで検証する。
//
// 実在のgit操作やリポジトリ状態には依存しない。文字列としてのコマンドをパースするだけの
// hookのため、合成コマンド文字列で足りる。

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { detectGitBranchCreation } from './gitBranchCreationMatcher.mjs'

describe('detectGitBranchCreation', () => {
  test('git branch への直接指定は作成とみなしブロックする', () => {
    assert.match(detectGitBranchCreation('git branch feature/foo'), /ブランチ作成/)
    assert.match(detectGitBranchCreation('git branch feature/foo main'), /ブランチ作成/)
  })

  test('git checkout -b / -B はブロックする', () => {
    assert.match(detectGitBranchCreation('git checkout -b feature/foo'), /ブランチ作成/)
    assert.match(detectGitBranchCreation('git checkout -B feature/foo'), /ブランチ作成/)
  })

  test('git switch -c / -C はブロックする', () => {
    assert.match(detectGitBranchCreation('git switch -c feature/foo'), /ブランチ作成/)
    assert.match(detectGitBranchCreation('git switch -C feature/foo'), /ブランチ作成/)
  })

  test('git branch -c / -C（コピー）もブランチ作成としてブロックする', () => {
    assert.match(detectGitBranchCreation('git branch -c old new'), /ブランチ作成/)
    assert.match(detectGitBranchCreation('git branch -C old new'), /ブランチ作成/)
  })

  test('連結コマンドの一部でも検出する', () => {
    assert.match(detectGitBranchCreation('npm test && git checkout -b foo'), /ブランチ作成/)
    assert.match(detectGitBranchCreation('git status; git switch -c foo'), /ブランチ作成/)
    assert.match(detectGitBranchCreation('git status | cat && git branch foo'), /ブランチ作成/)
  })

  test('一覧・削除・改名・切り替えはブロックしない', () => {
    assert.equal(detectGitBranchCreation('git branch'), null)
    assert.equal(detectGitBranchCreation('git branch -a'), null)
    assert.equal(detectGitBranchCreation('git branch -v'), null)
    assert.equal(detectGitBranchCreation('git branch -d old-branch'), null)
    assert.equal(detectGitBranchCreation('git branch -D old-branch'), null)
    assert.equal(detectGitBranchCreation('git branch -m old new'), null)
    assert.equal(detectGitBranchCreation('git branch --show-current'), null)
    assert.equal(detectGitBranchCreation('git checkout main'), null)
    assert.equal(detectGitBranchCreation('git checkout -- file.txt'), null)
    assert.equal(detectGitBranchCreation('git switch main'), null)
  })

  test('git以外のコマンドはブロックしない', () => {
    assert.equal(detectGitBranchCreation('npm test'), null)
    assert.equal(detectGitBranchCreation('ls -la'), null)
  })

  test('不正・空入力はブロックしない', () => {
    assert.equal(detectGitBranchCreation(''), null)
    assert.equal(detectGitBranchCreation(undefined), null)
    assert.equal(detectGitBranchCreation(null), null)
  })
})
