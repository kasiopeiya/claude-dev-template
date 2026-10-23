// 責務: ブランチ名の種類が git-commit Skill のブランチ命名規則にある7種類の内側に必ず収まることと、config.mjs の
// branchPrefix（種類の前に付ける接頭辞）が正しく付く・不正な値で止まることを検証する。
//
// ここが壊れると、pipeline.yml の push トリガに当たらないブランチができ、PR に checks が
// 1つも走らないまま無言でマージ不可になる。

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { buildBranchName, validateBranchPrefix } from '../branchName.mjs'

// git-commit Skill「ブランチ命名規則」と pipeline.yml の push トリガが共に許す種類（両者の写し）
const ALLOWED_BRANCH_TYPES = new Set(['feat', 'fix', 'refactor', 'chore', 'ci', 'test', 'docs'])

/** ラベルだけを変えて、接頭辞なしで Issue 1 のブランチ名を作る */
function buildBranchNameFor(labelNames) {
  return buildBranchName({ issueNumber: 1, labelNames, branchPrefix: '' })
}

describe('ブランチ名の種類', () => {
  test('種類ラベルに対応する種類になる', () => {
    const sut = buildBranchNameFor

    assert.equal(sut(['feature']), 'feat/issue-1')
    assert.equal(sut(['bug']), 'fix/issue-1')
    assert.equal(sut(['cicd']), 'ci/issue-1')
    assert.equal(sut(['refactor']), 'refactor/issue-1')
    assert.equal(sut(['docs']), 'docs/issue-1')
    assert.equal(sut(['chore']), 'chore/issue-1')
  })

  test('種類ラベル以外のラベルは種類に影響しない', () => {
    const sut = buildBranchNameFor

    const branchName = sut(['ai-fixable', 'broken-window', 'docs'])

    assert.equal(branchName, 'docs/issue-1')
  })

  test('種類ラベルが複数あるときは優先順位の高いものが選ばれる', () => {
    const sut = buildBranchNameFor

    const branchName = sut(['docs', 'chore', 'feature'])

    assert.equal(branchName, 'feat/issue-1')
  })

  test('種類ラベルが無いときは chore になる', () => {
    const sut = buildBranchNameFor

    assert.equal(sut([]), 'chore/issue-1')
    assert.equal(sut(['ai-fixable']), 'chore/issue-1')
    assert.equal(sut(undefined), 'chore/issue-1')
  })

  test('どのラベルの組み合わせでも CI が走る種類になる', () => {
    const sut = buildBranchNameFor
    const labelCombinations = [[], ['ai-fixable'], ['feature', 'bug'], ['cicd', 'docs'], ['bug']]

    const branchTypes = labelCombinations.map((labelNames) => sut(labelNames).split('/')[0])

    for (const branchType of branchTypes) {
      assert.ok(ALLOWED_BRANCH_TYPES.has(branchType), `CI の対象外の種類: ${branchType}`)
    }
  })
})

describe('ブランチ名の組み立て', () => {
  test('同じ Issue からは毎回同じブランチ名になる', () => {
    const sut = buildBranchName
    const issue = { issueNumber: 480, labelNames: ['feature'], branchPrefix: '' }

    const first = sut(issue)
    const second = sut(issue)

    assert.equal(first, 'feat/issue-480')
    assert.equal(first, second)
  })

  test('Issue 番号が正の整数でなければ例外になる', () => {
    const sut = buildBranchName

    assert.throws(
      () => sut({ issueNumber: 0, labelNames: ['feature'], branchPrefix: '' }),
      TypeError
    )
    assert.throws(
      () => sut({ issueNumber: -1, labelNames: ['feature'], branchPrefix: '' }),
      TypeError
    )
    assert.throws(
      () => sut({ issueNumber: 1.5, labelNames: ['feature'], branchPrefix: '' }),
      TypeError
    )
    assert.throws(
      () => sut({ issueNumber: '480', labelNames: ['feature'], branchPrefix: '' }),
      TypeError
    )
  })
})

describe('ブランチ名の接頭辞', () => {
  test('接頭辞が未指定・空文字の場合に付けない', () => {
    const sut = buildBranchName

    for (const branchPrefix of [undefined, '']) {
      const branchName = sut({ issueNumber: 1, labelNames: ['feature'], branchPrefix })

      assert.equal(branchName, 'feat/issue-1', `付けないはずの値: ${String(branchPrefix)}`)
    }
  })

  test('接頭辞がある場合に種類の前に付く', () => {
    const sut = buildBranchName

    const branchName = sut({ issueNumber: 1, labelNames: ['feature'], branchPrefix: 'st2' })

    assert.equal(branchName, 'st2/feat/issue-1')
  })

  test('接頭辞が不正な場合にブランチ名を作らず例外になる', () => {
    const sut = buildBranchName

    assert.throws(
      () => sut({ issueNumber: 1, labelNames: ['feature'], branchPrefix: 'st2/' }),
      Error
    )
  })
})

describe('接頭辞の検査', () => {
  test('接頭辞が未指定・空文字の場合に例外にならない', () => {
    const sut = validateBranchPrefix

    for (const branchPrefix of [undefined, '']) {
      assert.doesNotThrow(() => sut(branchPrefix), `通るはずの値: ${String(branchPrefix)}`)
    }
  })

  test('接頭辞が1段の正しい名前の場合に例外にならない', () => {
    const sut = validateBranchPrefix

    for (const branchPrefix of ['st2', 'st_2', 'ST-2']) {
      assert.doesNotThrow(() => sut(branchPrefix), `通るはずの値: ${branchPrefix}`)
    }
  })

  test('ブランチ名にできない値・多段・文字列以外の場合に例外になる', () => {
    const sut = validateBranchPrefix

    for (const branchPrefix of [
      '-st2',
      '/st2',
      'st2/',
      'team/st2',
      'st 2',
      'st2.lock',
      123,
      null
    ]) {
      assert.throws(() => sut(branchPrefix), Error, `止まるはずの値: ${String(branchPrefix)}`)
    }
  })
})
