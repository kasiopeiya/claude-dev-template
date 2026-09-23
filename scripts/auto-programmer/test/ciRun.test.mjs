// 責務: push 後の CI の run の状態の読み方と、次にすること（通った・直させる・諦める・やめる）の決め方を検証する。
//
// ここが壊れると、通っていない PR を通ったものとして次の Issue へ進むか、キャンセルされただけの run を
// AI に何度も直させ、無関係なコミットが誰にも見られずに積まれる。

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { decideAfterCiRun, readCiRunState } from '../ciRun.mjs'

const HEAD_SHA = 'aaaaaaa'

/** `gh run list` の1件を作る。指定しなかった項目は、待っている commit で成功した run の既定値になる */
function createRun(overrides = {}) {
  return {
    databaseId: 100,
    status: 'completed',
    conclusion: 'success',
    headSha: HEAD_SHA,
    url: 'https://example.com/runs/100',
    ...overrides
  }
}

describe('run の状態を読む', () => {
  test('待っている commit の run がまだ無ければ、終わっていないものとして読む', () => {
    const sut = readCiRunState

    const runState = sut([createRun({ headSha: 'bbbbbbb' })], HEAD_SHA)

    assert.equal(runState.state, 'pending')
  })

  test('終わっていない run は、終わっていないものとして読む', () => {
    const sut = readCiRunState

    const runState = sut([createRun({ status: 'in_progress', conclusion: '' })], HEAD_SHA)

    assert.equal(runState.state, 'pending')
  })

  test('成功した run は、通ったものとして読む', () => {
    const sut = readCiRunState

    const runState = sut([createRun()], HEAD_SHA)

    assert.deepEqual(runState, {
      state: 'success',
      runId: 100,
      conclusion: 'success',
      url: 'https://example.com/runs/100'
    })
  })

  for (const conclusion of ['failure', 'timed_out']) {
    test(`${conclusion} で終わった run は、直させる対象として読む`, () => {
      const sut = readCiRunState

      const runState = sut([createRun({ conclusion })], HEAD_SHA)

      assert.equal(runState.state, 'fixable-failure')
    })
  }

  test('キャンセルされた run は、直させる対象として読まない', () => {
    const sut = readCiRunState

    const runState = sut([createRun({ conclusion: 'cancelled' })], HEAD_SHA)

    assert.equal(runState.state, 'unfixable')
  })

  test('同じ commit に run が複数あれば最後に作られたものを見る', () => {
    const sut = readCiRunState

    const runState = sut(
      [createRun({ databaseId: 200 }), createRun({ databaseId: 100, conclusion: 'failure' })],
      HEAD_SHA
    )

    assert.equal(runState.runId, 200)
    assert.equal(runState.state, 'success')
  })
})

describe('次にすることを決める', () => {
  test('通っていれば、通ったと決める', () => {
    const sut = decideAfterCiRun

    const nextStep = sut({ state: 'success', fixAttemptCount: 0, maxFixAttempts: 2 })

    assert.equal(nextStep, 'finish-passed')
  })

  test('落ちていて上限に達していなければ直させる', () => {
    const sut = decideAfterCiRun

    const nextStep = sut({ state: 'fixable-failure', fixAttemptCount: 1, maxFixAttempts: 2 })

    assert.equal(nextStep, 'fix')
  })

  test('上限まで直させても落ちていれば諦める', () => {
    const sut = decideAfterCiRun

    const nextStep = sut({ state: 'fixable-failure', fixAttemptCount: 2, maxFixAttempts: 2 })

    assert.equal(nextStep, 'hand-over')
  })

  test('キャンセルされた run は直させずにやめる', () => {
    const sut = decideAfterCiRun

    const nextStep = sut({ state: 'unfixable', fixAttemptCount: 0, maxFixAttempts: 2 })

    assert.equal(nextStep, 'stop-unfixable')
  })

  test('待ち時間内に終わらなかった run は直させずにやめる', () => {
    const sut = decideAfterCiRun

    const nextStep = sut({ state: 'pending', fixAttemptCount: 0, maxFixAttempts: 2 })

    assert.equal(nextStep, 'stop-timed-out')
  })
})
