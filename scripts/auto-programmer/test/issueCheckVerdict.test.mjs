// 責務: /issue-check を通した後の Issue の状態から、実装へ進むか止めるかが決まることを検証する。
//
// ここが壊れると、人間が決めるべき Issue や不要と判定された Issue まで無人で実装され、
// 誤った方針の PR が誰にも見られずにできる。

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { findReasonToSkipImplementation } from '../issueCheckVerdict.mjs'

/** 監査後の Issue を作る。指定しなかった項目は、監査を通過した open な Issue の既定値になる */
function createCheckedIssue(overrides = {}) {
  return { state: 'OPEN', labelNames: ['ai-fixable', 'issue:checked'], ...overrides }
}

describe('実装へ進む', () => {
  test('監査を通過した open な Issue は止めない', () => {
    const sut = findReasonToSkipImplementation

    const reason = sut(createCheckedIssue())

    assert.equal(reason, null)
  })
})

describe('実装へ進まない', () => {
  test('人間判断のラベルが付いた Issue は止める', () => {
    const sut = findReasonToSkipImplementation

    const reason = sut(
      createCheckedIssue({ labelNames: ['issue:checked', 'issue:needs-human-decision'] })
    )

    assert.match(reason, /issue:needs-human-decision/)
  })

  test('判定が書き戻されていない Issue は止める', () => {
    const sut = findReasonToSkipImplementation

    const reason = sut(createCheckedIssue({ labelNames: ['ai-fixable'] }))

    assert.match(reason, /書き戻しませんでした/)
  })

  test('close された Issue は止める', () => {
    const sut = findReasonToSkipImplementation

    const reason = sut(createCheckedIssue({ state: 'CLOSED' }))

    assert.match(reason, /close/)
  })
})
