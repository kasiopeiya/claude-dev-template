// 責務: /issue-check を通した後の Issue の状態から、実装へ進むか止めるかが決まることを検証する。
//
// ここが壊れると、人間が決めるべき Issue・人間しかできない作業の Issue・不要と判定された Issue まで無人で実装され、
// 誤った方針の PR が誰にも見られずにできる。

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { findSkipImplementationDecision } from '../issueCheckVerdict.mjs'

const TARGET_ISSUE_LABEL = 'ai-fixable'

/** 監査後の Issue を作る。指定しなかった項目は、監査を通過した open な Issue の既定値になる */
function createCheckedIssue(overrides = {}) {
  return { state: 'OPEN', labelNames: ['ai-fixable', 'issue:checked'], ...overrides }
}

describe('実装へ進む', () => {
  test('監査を通過した open な Issue は止めない', () => {
    const sut = findSkipImplementationDecision
    const issue = createCheckedIssue()

    const skipDecision = sut(issue, TARGET_ISSUE_LABEL)

    assert.equal(skipDecision, null)
  })
})

describe('実装へ進まない', () => {
  test('人間判断のラベルが付いた Issue は、判定として止める', () => {
    const sut = findSkipImplementationDecision
    const issue = createCheckedIssue({
      labelNames: ['issue:checked', 'needs-human-decision']
    })

    const skipDecision = sut(issue, TARGET_ISSUE_LABEL)

    assert.match(skipDecision.reason, /needs-human-decision/)
    assert.equal(skipDecision.isVerdict, true)
  })

  test('人間しかできない作業のラベルが付いた Issue は、判定として止める', () => {
    const sut = findSkipImplementationDecision
    const issue = createCheckedIssue({ labelNames: ['issue:checked', 'ready-for-human'] })

    const skipDecision = sut(issue, TARGET_ISSUE_LABEL)

    assert.match(skipDecision.reason, /ready-for-human/)
    assert.equal(skipDecision.isVerdict, true)
  })

  test('人間しかできない作業のラベルが対象ラベルと一緒に付いた Issue も止める', () => {
    const sut = findSkipImplementationDecision
    const issue = createCheckedIssue({
      labelNames: ['ai-fixable', 'issue:checked', 'ready-for-human']
    })

    const skipDecision = sut(issue, TARGET_ISSUE_LABEL)

    assert.match(skipDecision.reason, /ready-for-human/)
  })

  test('対象ラベルが外れた Issue は、判定として止める', () => {
    const sut = findSkipImplementationDecision
    const issue = createCheckedIssue({ labelNames: ['issue:checked'] })

    const skipDecision = sut(issue, TARGET_ISSUE_LABEL)

    assert.match(skipDecision.reason, /ai-fixable を外しました/)
    assert.equal(skipDecision.isVerdict, true)
  })

  test('判定が書き戻されていない Issue は、判定ではない理由で止める', () => {
    const sut = findSkipImplementationDecision
    const issue = createCheckedIssue({ labelNames: ['ai-fixable'] })

    const skipDecision = sut(issue, TARGET_ISSUE_LABEL)

    assert.match(skipDecision.reason, /書き戻しませんでした/)
    assert.equal(skipDecision.isVerdict, false)
  })

  test('close された Issue は、判定として止める', () => {
    const sut = findSkipImplementationDecision
    const issue = createCheckedIssue({ state: 'CLOSED' })

    const skipDecision = sut(issue, TARGET_ISSUE_LABEL)

    assert.match(skipDecision.reason, /close/)
    assert.equal(skipDecision.isVerdict, true)
  })
})
