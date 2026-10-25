// 責務: push の後、CI を待つ前に、待たない理由と、それが予定した終わり方かが決まることを検証する。
//
// ここが壊れると、PR がマージされて消えたブランチを「差分が出ない Issue」と記録して CI の結果を読めなくなるか、
// 待つべき CI を待たずに終え、落ちた PR が誰にも直されずに残る。

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { findDecisionNotToWaitForCi } from '../ciWaitDecision.mjs'

const WORK_STARTED_AT = '2026-01-10T00:00:00.000Z'
const PULL_REQUEST_MERGED_DURING_THIS_WORK = { number: 1111, mergedAt: '2026-01-10T00:30:00Z' }

/** 判定の入力を作る。指定しなかった項目は、このツールが push した commit の CI を待つ入力の既定値になる */
function createParams(overrides = {}) {
  return {
    state: 'OPEN',
    labelNames: [],
    remoteHeadSha: 'pushed-sha',
    localHeadSha: 'pushed-sha',
    previousHeadSha: null,
    lastSessionName: '/auto-dev',
    mergedPullRequest: null,
    workStartedAt: WORK_STARTED_AT,
    ...overrides
  }
}

describe('ブランチが無く Issue が CLOSED のとき', () => {
  test('マージ済みの PR があれば、CI が通った終わり方と読む', () => {
    const sut = findDecisionNotToWaitForCi

    const decision = sut(
      createParams({
        state: 'CLOSED',
        remoteHeadSha: '',
        mergedPullRequest: PULL_REQUEST_MERGED_DURING_THIS_WORK
      })
    )

    assert.deepEqual(decision, {
      ciOutcome: 'PR #1111 がマージ済みです',
      isCiPassed: true,
      isClosedWithoutChanges: false
    })
  })

  test('作業を始めた時刻ちょうどにマージされた PR も、今回の作業の PR と読む', () => {
    const sut = findDecisionNotToWaitForCi
    const workStartedAt = '2026-01-10T00:00:00.000Z'

    const decision = sut(
      createParams({
        state: 'CLOSED',
        remoteHeadSha: '',
        workStartedAt,
        mergedPullRequest: { number: 1111, mergedAt: workStartedAt }
      })
    )

    assert.equal(decision?.isCiPassed, true)
  })

  test('作業を始める前にマージされた PR（再オープンされた Issue の前回の PR）は、差分が出ない Issue を /auto-dev が閉じたと読む', () => {
    const sut = findDecisionNotToWaitForCi
    const workStartedAt = '2026-01-10T00:00:00.000Z'
    const oneSecondBeforeWorkStarted = '2026-01-09T23:59:59Z'

    const decision = sut(
      createParams({
        state: 'CLOSED',
        remoteHeadSha: '',
        workStartedAt,
        mergedPullRequest: { number: 900, mergedAt: oneSecondBeforeWorkStarted }
      })
    )

    assert.deepEqual(decision, {
      ciOutcome: '差分が出ないので /auto-dev が Issue を閉じました',
      isCiPassed: false,
      isClosedWithoutChanges: true
    })
  })

  test('マージ済みの PR が無ければ、差分が出ない Issue を /auto-dev が閉じたと読む', () => {
    const sut = findDecisionNotToWaitForCi

    const decision = sut(createParams({ state: 'CLOSED', remoteHeadSha: '' }))

    assert.deepEqual(decision, {
      ciOutcome: '差分が出ないので /auto-dev が Issue を閉じました',
      isCiPassed: false,
      isClosedWithoutChanges: true
    })
  })
})

describe('予定した終わり方ではないので、人間の手当てが要ると読む', () => {
  test('needs-human-check が付いていれば、マージ済みの PR があっても待たない', () => {
    const sut = findDecisionNotToWaitForCi

    const decision = sut(
      createParams({
        state: 'CLOSED',
        remoteHeadSha: '',
        labelNames: ['needs-human-check'],
        mergedPullRequest: PULL_REQUEST_MERGED_DURING_THIS_WORK
      })
    )

    assert.equal(decision?.isCiPassed, false)
    assert.equal(decision?.isClosedWithoutChanges, false)
  })

  test('大文字小文字の違う Needs-Human-Check が付いていても、マージ済みの PR があっても待たない', () => {
    const sut = findDecisionNotToWaitForCi

    const decision = sut(
      createParams({
        state: 'CLOSED',
        remoteHeadSha: '',
        labelNames: ['Needs-Human-Check'],
        mergedPullRequest: PULL_REQUEST_MERGED_DURING_THIS_WORK
      })
    )

    assert.equal(decision?.ciOutcome, 'needs-human-check が付いているので CI を待ちません')
    assert.equal(decision?.isCiPassed, false)
  })

  test('ブランチが無く Issue が OPEN なら、push されていないと読む', () => {
    const sut = findDecisionNotToWaitForCi

    const decision = sut(createParams({ remoteHeadSha: '' }))

    assert.deepEqual(decision, {
      ciOutcome: 'ブランチが push されていないので CI を待ちません',
      isCiPassed: false,
      isClosedWithoutChanges: false
    })
  })

  test('ブランチが無く Issue が OPEN なら、マージ済みの PR があっても push されていないと読む', () => {
    const sut = findDecisionNotToWaitForCi

    const decision = sut(
      createParams({ remoteHeadSha: '', mergedPullRequest: PULL_REQUEST_MERGED_DURING_THIS_WORK })
    )

    assert.equal(decision?.ciOutcome, 'ブランチが push されていないので CI を待ちません')
    assert.equal(decision?.isCiPassed, false)
  })

  test('リモートの SHA が前回と同じなら、直前のセッションが push しなかったと読む', () => {
    const sut = findDecisionNotToWaitForCi

    const decision = sut(createParams({ previousHeadSha: 'pushed-sha' }))

    assert.equal(decision?.ciOutcome, '/auto-dev が push しませんでした')
    assert.equal(decision?.isCiPassed, false)
  })

  test('リモートの SHA が clone の HEAD と違えば、このツール以外の push と読む', () => {
    const sut = findDecisionNotToWaitForCi

    const decision = sut(createParams({ localHeadSha: 'other-sha' }))

    assert.equal(
      decision?.ciOutcome,
      'リモートのブランチに、このツール以外の push があるので CI を待ちません'
    )
    assert.equal(decision?.isCiPassed, false)
  })
})

test('このツールが新しく push した commit なら、CI を待つ', () => {
  const sut = findDecisionNotToWaitForCi

  const decision = sut(createParams())

  assert.equal(decision, null)
})
