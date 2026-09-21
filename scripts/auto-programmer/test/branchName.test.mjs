// 責務: ブランチ名の決定が、git-policy の7プレフィックスの内側に必ず収まることを検証する。
//
// ここが壊れると、pipeline.yml の push トリガに当たらないブランチができ、PR に checks が
// 1つも走らないまま無言でマージ不可になる。

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { buildBranchName } from '../branchName.mjs'

// git-policy「ブランチ命名規則」と pipeline.yml の push トリガが共に許す prefix（両者の写し）
const ALLOWED_PREFIXES = new Set(['feat', 'fix', 'refactor', 'chore', 'ci', 'test', 'docs'])

/** ラベルだけを変えて、Issue 1 のブランチ名を作る */
function buildBranchNameFor(labelNames) {
  return buildBranchName({ issueNumber: 1, labelNames })
}

describe('ブランチ名の prefix', () => {
  test('種類ラベルに対応する prefix になる', () => {
    const sut = buildBranchNameFor

    assert.equal(sut(['feature']), 'feat/issue-1')
    assert.equal(sut(['bug']), 'fix/issue-1')
    assert.equal(sut(['cicd']), 'ci/issue-1')
    assert.equal(sut(['refactor']), 'refactor/issue-1')
    assert.equal(sut(['docs']), 'docs/issue-1')
    assert.equal(sut(['chore']), 'chore/issue-1')
  })

  test('種類ラベル以外のラベルは prefix に影響しない', () => {
    const sut = buildBranchNameFor

    const branchName = sut(['ai-fixable', 'boy-scout', 'docs'])

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

  test('どのラベルの組み合わせでも CI が走る prefix になる', () => {
    const sut = buildBranchNameFor
    const labelCombinations = [[], ['ai-fixable'], ['feature', 'bug'], ['cicd', 'docs'], ['bug']]

    const prefixes = labelCombinations.map((labelNames) => sut(labelNames).split('/')[0])

    for (const prefix of prefixes) {
      assert.ok(ALLOWED_PREFIXES.has(prefix), `CI の対象外の prefix: ${prefix}`)
    }
  })
})

describe('ブランチ名の組み立て', () => {
  test('同じ Issue からは毎回同じブランチ名になる', () => {
    const sut = buildBranchName
    const issue = { issueNumber: 480, labelNames: ['feature'] }

    const first = sut(issue)
    const second = sut(issue)

    assert.equal(first, 'feat/issue-480')
    assert.equal(first, second)
  })

  test('Issue 番号が正の整数でなければ例外になる', () => {
    const sut = buildBranchName

    assert.throws(() => sut({ issueNumber: 0, labelNames: ['feature'] }), TypeError)
    assert.throws(() => sut({ issueNumber: -1, labelNames: ['feature'] }), TypeError)
    assert.throws(() => sut({ issueNumber: 1.5, labelNames: ['feature'] }), TypeError)
    assert.throws(() => sut({ issueNumber: '480', labelNames: ['feature'] }), TypeError)
  })
})
