// 責務: Issue 1件を終えた結果から、`needs-human-check` を付けるかが決まることを検証する。
//
// ここが壊れると、無人実行が止まった Issue に印が付かず、人間が止まったことに気付けないまま放置されるか、
// 予定どおり終えた Issue にまで印が付き、確かめる対象が埋もれる。

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { shouldMarkAsNeedsHumanCheck } from '../needsHumanCheck.mjs'

/** 記録を作る。指定しなかった項目は、実装して CI が通った実行の既定値になる */
function createRecord(overrides = {}) {
  return { skippedReason: null, isCiPassed: true, isClosedWithoutChanges: false, ...overrides }
}

describe('予定した終わり方なので付けない', () => {
  test('CI が通ったなら付けない', () => {
    const sut = shouldMarkAsNeedsHumanCheck

    const shouldMark = sut(createRecord(), true)

    assert.equal(shouldMark, false)
  })

  test('差分が出ない Issue を /auto-dev が閉じたなら付けない', () => {
    const sut = shouldMarkAsNeedsHumanCheck

    const shouldMark = sut(createRecord({ isCiPassed: false, isClosedWithoutChanges: true }), true)

    assert.equal(shouldMark, false)
  })

  test('/issue-check の判定で止めたなら付けない', () => {
    const sut = shouldMarkAsNeedsHumanCheck
    const record = {
      skippedReason: '/issue-check が人間の判断を要すると判定しました',
      isSkippedByIssueCheckVerdict: true
    }

    const shouldMark = sut(record, true)

    assert.equal(shouldMark, false)
  })

  test('子を1件以上、着手待ちに載せたなら付けない', () => {
    const sut = shouldMarkAsNeedsHumanCheck

    const shouldMark = sut({ subIssueHandover: { putOnReadySubIssueNumbers: [12] } }, true)

    assert.equal(shouldMark, false)
  })

  test('子を1件以上載せたなら、判定が書き戻されていなくても付けない', () => {
    const sut = shouldMarkAsNeedsHumanCheck
    const record = {
      subIssueHandover: { putOnReadySubIssueNumbers: [12] },
      skippedReason: '/issue-check が判定を書き戻しませんでした',
      isSkippedByIssueCheckVerdict: false
    }

    const shouldMark = sut(record, true)

    assert.equal(shouldMark, false)
  })

  test('判定で止めたなら、載せた子が0件でも付けない', () => {
    const sut = shouldMarkAsNeedsHumanCheck
    const record = {
      subIssueHandover: { putOnReadySubIssueNumbers: [] },
      skippedReason: '/issue-check が人間の判断を要すると判定しました',
      isSkippedByIssueCheckVerdict: true
    }

    const shouldMark = sut(record, true)

    assert.equal(shouldMark, false)
  })
})

describe('予定した終わり方以外なので付ける', () => {
  test('処理中に例外が出たなら、CI が通っていても付ける', () => {
    const sut = shouldMarkAsNeedsHumanCheck

    const shouldMark = sut(createRecord({ error: 'gh が失敗しました' }), true)

    assert.equal(shouldMark, true)
  })

  test('claude のセッションが失敗したなら、CI が通っていても付ける', () => {
    const sut = shouldMarkAsNeedsHumanCheck

    const shouldMark = sut(createRecord(), false)

    assert.equal(shouldMark, true)
  })

  test('/issue-check が判定を書き戻さなかったなら付ける', () => {
    const sut = shouldMarkAsNeedsHumanCheck
    const record = {
      skippedReason: '/issue-check が判定を書き戻しませんでした',
      isSkippedByIssueCheckVerdict: false
    }

    const shouldMark = sut(record, true)

    assert.equal(shouldMark, true)
  })

  test('子へ引き継ごうとして、1件も着手待ちに載せられなかったなら付ける', () => {
    const sut = shouldMarkAsNeedsHumanCheck

    const shouldMark = sut({ subIssueHandover: { putOnReadySubIssueNumbers: [] } }, true)

    assert.equal(shouldMark, true)
  })

  test('CI が通らなかった（上限まで直させても落ちた・時間切れ・キャンセル・離脱）なら付ける', () => {
    const sut = shouldMarkAsNeedsHumanCheck

    const shouldMark = sut(createRecord({ isCiPassed: false }), true)

    assert.equal(shouldMark, true)
  })
})
