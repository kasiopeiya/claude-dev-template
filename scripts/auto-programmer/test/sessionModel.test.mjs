// 責務: 無人の claude セッションに渡すモデルと effort の、設定の検査と引数の組み立てを検証する。
//
// ここが壊れると、設定が欠けた利用先で無人実行が ~/.claude/settings.json を黙って継ぎ、対話の /model に
// 引きずられるか、設定した値が claude に届かない。

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { inspect } from 'node:util'

import { buildSessionModelArgs, validateSessionModelSettings } from '../sessionModel.mjs'

describe('モデルと effort の設定を検査する', () => {
  test('どちらも空でない文字列なら通す', () => {
    const sut = validateSessionModelSettings

    assert.doesNotThrow(() => sut({ sessionModel: 'sonnet', sessionEffort: 'xhigh' }))
  })

  for (const brokenSetting of [undefined, '', 3]) {
    test(`モデルが欠けている・空・文字列でない（${inspect(brokenSetting)}）場合に、キー名を示して投げる`, () => {
      const sut = validateSessionModelSettings

      assert.throws(
        () => sut({ sessionModel: brokenSetting, sessionEffort: 'xhigh' }),
        /sessionModel/
      )
    })

    test(`effort が欠けている・空・文字列でない（${inspect(brokenSetting)}）場合に、キー名を示して投げる`, () => {
      const sut = validateSessionModelSettings

      assert.throws(
        () => sut({ sessionModel: 'sonnet', sessionEffort: brokenSetting }),
        /sessionEffort/
      )
    })
  }
})

describe('claude に渡す引数を組み立てる', () => {
  test('設定したモデルと effort を --model・--effort で渡す', () => {
    const sut = buildSessionModelArgs

    const sessionModelArgs = sut({ sessionModel: 'sonnet', sessionEffort: 'xhigh' })

    assert.deepEqual(sessionModelArgs, ['--model', 'sonnet', '--effort', 'xhigh'])
  })
})
