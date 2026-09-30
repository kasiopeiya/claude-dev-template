// 責務: open な sub-issue を持つ Issue を子へ引き継ぐかと、着手待ちに載せる子の選び方を検証する。
//
// ここが壊れると、umbrella になった親が子と二重に実装されるか、子が誰にも拾われずに放置される。
// 他人が担当する子・判断待ちの子・着手済みの子を着手待ちに載せ、取り合いや二重の実装も起きる。

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  findReasonToSkipForOpenSubIssues,
  selectSubIssuesToPutOnReady
} from '../subIssueHandover.mjs'

describe('open な sub-issue の有無で止めるか', () => {
  test('open な子を持つ Issue は止める', () => {
    const sut = findReasonToSkipForOpenSubIssues

    const reason = sut([{ state: 'CLOSED' }, { state: 'OPEN' }])

    assert.match(reason, /sub-issue を 1 件/)
  })

  test('子が全部 close された Issue は止めない', () => {
    const sut = findReasonToSkipForOpenSubIssues

    const reason = sut([{ state: 'CLOSED' }])

    assert.equal(reason, null)
  })

  test('子を持たない Issue は止めない', () => {
    const sut = findReasonToSkipForOpenSubIssues

    const reason = sut([])

    assert.equal(reason, null)
  })
})

describe('着手待ちに載せる子の選び方', () => {
  const criteria = {
    repository: 'owner/repo',
    viewerLogin: 'me',
    targetIssueLabel: 'ai-fixable',
    needsHumanDecisionLabel: 'issue:needs-human-decision',
    notStartedStatusNames: ['Todo', 'Ready']
  }

  /** sub-issue を作る。指定しなかった項目は、着手待ちに載せてよい子の既定値になる */
  function createSubIssue(overrides = {}) {
    return {
      repository: 'owner/repo',
      state: 'OPEN',
      labelNames: ['ai-fixable'],
      assigneeLogins: [],
      boardStatusName: null,
      ...overrides
    }
  }

  test('担当者が無く対象ラベル付きの、ボードに無い open な子は載せる', () => {
    const sut = selectSubIssuesToPutOnReady
    const subIssue = createSubIssue()

    const selected = sut([subIssue], criteria)

    assert.deepEqual(selected, [subIssue])
  })

  test('担当者が自分だけの子は載せる', () => {
    const sut = selectSubIssuesToPutOnReady
    const subIssue = createSubIssue({ assigneeLogins: ['me'] })

    const selected = sut([subIssue], criteria)

    assert.deepEqual(selected, [subIssue])
  })

  for (const boardStatusName of ['Todo', 'Ready']) {
    test(`カードが着手前の ${boardStatusName} にある子は載せる`, () => {
      const sut = selectSubIssuesToPutOnReady
      const subIssue = createSubIssue({ boardStatusName })

      const selected = sut([subIssue], criteria)

      assert.deepEqual(selected, [subIssue])
    })
  }

  test('自分以外の担当者がいる子は載せない', () => {
    const sut = selectSubIssuesToPutOnReady

    const selected = sut([createSubIssue({ assigneeLogins: ['me', 'other'] })], criteria)

    assert.deepEqual(selected, [])
  })

  test('人間の判断を待つ子は載せない', () => {
    const sut = selectSubIssuesToPutOnReady
    const subIssue = createSubIssue({ labelNames: ['ai-fixable', 'issue:needs-human-decision'] })

    const selected = sut([subIssue], criteria)

    assert.deepEqual(selected, [])
  })

  test('close された子は載せない', () => {
    const sut = selectSubIssuesToPutOnReady

    const selected = sut([createSubIssue({ state: 'CLOSED' })], criteria)

    assert.deepEqual(selected, [])
  })

  test('対象ラベルの無い子は載せない', () => {
    const sut = selectSubIssuesToPutOnReady

    const selected = sut([createSubIssue({ labelNames: [] })], criteria)

    assert.deepEqual(selected, [])
  })

  for (const boardStatusName of ['In progress', 'In Review', 'Done']) {
    test(`カードが着手した後の ${boardStatusName} にある子は載せない`, () => {
      const sut = selectSubIssuesToPutOnReady

      const selected = sut([createSubIssue({ boardStatusName })], criteria)

      assert.deepEqual(selected, [])
    })
  }

  test('対象リポジトリの外にある子は載せない', () => {
    const sut = selectSubIssuesToPutOnReady

    const selected = sut([createSubIssue({ repository: 'owner/other-repo' })], criteria)

    assert.deepEqual(selected, [])
  })
})
