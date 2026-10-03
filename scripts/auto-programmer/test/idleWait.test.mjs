// 責務: 着手できない周が続いたときの、待つ・止めるの境目と、上限の検査を検証する。
//
// ここが壊れると、境目が1つずれて待つ回数が指定と食い違うか、設定が欠けた利用先で上限が効かないまま
// 放置され、gh のレート制限に触れ続ける。

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { inspect } from 'node:util'

import { decideAfterIdlePoll, validateMaxConsecutiveIdleWaits } from '../idleWait.mjs'

const MAX_CONSECUTIVE_IDLE_WAITS = 10

describe('待つか止めるかを決める', () => {
  test('1回目の空振りでは待つ', () => {
    const sut = decideAfterIdlePoll

    const decision = sut({ idlePollCount: 1, maxConsecutiveIdleWaits: MAX_CONSECUTIVE_IDLE_WAITS })

    assert.equal(decision, 'wait')
  })

  test('回数が上限ちょうどのときは、まだ待つ', () => {
    const sut = decideAfterIdlePoll

    const decision = sut({
      idlePollCount: MAX_CONSECUTIVE_IDLE_WAITS,
      maxConsecutiveIdleWaits: MAX_CONSECUTIVE_IDLE_WAITS
    })

    assert.equal(decision, 'wait')
  })

  test('回数が上限を1つ超えたら、待たずに止める', () => {
    const sut = decideAfterIdlePoll

    const decision = sut({
      idlePollCount: MAX_CONSECUTIVE_IDLE_WAITS + 1,
      maxConsecutiveIdleWaits: MAX_CONSECUTIVE_IDLE_WAITS
    })

    assert.equal(decision, 'stop')
  })
})

describe('待ってよい回数の上限を検査する', () => {
  for (const maxConsecutiveIdleWaits of [1, 10]) {
    test(`上限が1以上の整数（${inspect(maxConsecutiveIdleWaits)}）なら通す`, () => {
      const sut = validateMaxConsecutiveIdleWaits

      assert.doesNotThrow(() => sut(maxConsecutiveIdleWaits))
    })
  }

  for (const maxConsecutiveIdleWaits of [undefined, 0, -1, 1.5, '10', Number.NaN]) {
    test(`上限が欠けている・1以上の整数でない（${inspect(maxConsecutiveIdleWaits)}）なら、設定へ足すよう伝えて投げる`, () => {
      const sut = validateMaxConsecutiveIdleWaits

      assert.throws(() => sut(maxConsecutiveIdleWaits), /maxConsecutiveIdleWaits/)
    })
  }
})
