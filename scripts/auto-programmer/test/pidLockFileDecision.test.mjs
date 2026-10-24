// 責務: PID 入りのロックファイルについて、死んだロックの見分け・持ち主の PID の読み出しと、一番小さい空き番号の選び方を検証する。
//
// ここが壊れると、生きているロックを取り直して2つのプロセスが同じ clone で reset --hard し合う・同じ Issue を実装し合うか、
// 死んだロックを取り直せずに clone が増え続ける・Issue を拾えなくなる。持ち主の PID を読み違えると、人間が残ったロックを見分けられない。

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildLockFileContent,
  isLockDead,
  readLockHolderPid,
  selectLowestFreeNumber
} from '../pidLockFileDecision.mjs'

const HOLDER_PID = 4242
const BOOTED_AT = new Date('2026-10-24T09:00:00.000Z')
const CURRENT_BOOT_ID = 'current-boot'

/**
 * 起動時刻から指定の秒数だけずらした時刻に作ったロックファイルの中身を作る。
 *
 * @param {number} secondsFromBoot 起動時刻からの秒数（前なら負）
 * @param {{ bootId?: string | null }} [options] ロックを作った起動の ID（省略時は ID を引けない OS で作ったものとして null）
 * @returns {string} ロックファイルの中身
 */
function buildLockFileContentCreatedAt(secondsFromBoot, { bootId = null } = {}) {
  return buildLockFileContent({
    pid: HOLDER_PID,
    createdAt: new Date(BOOTED_AT.getTime() + secondsFromBoot * 1000),
    bootId
  })
}

/**
 * いまの起動を作る。
 *
 * @param {{ bootId?: string | null }} [options] いまの起動の ID（省略時は ID を引けない OS として null）
 * @returns {{ bootedAtMs: number, bootId: string | null }} いまの起動
 */
function buildCurrentBoot({ bootId = null } = {}) {
  return { bootedAtMs: BOOTED_AT.getTime(), bootId }
}

describe('ロックが死んでいるかを決める', () => {
  test('起動後に作られ、持ち主のプロセスが動いていれば生きている', () => {
    const sut = isLockDead

    const isDead = sut({
      lockFileContent: buildLockFileContentCreatedAt(3600),
      isProcessRunning: (pid) => pid === HOLDER_PID,
      currentBoot: buildCurrentBoot()
    })

    assert.equal(isDead, false)
  })

  test('持ち主のプロセスが動いていなければ死んでいる', () => {
    const sut = isLockDead

    const isDead = sut({
      lockFileContent: buildLockFileContentCreatedAt(3600),
      isProcessRunning: () => false,
      currentBoot: buildCurrentBoot()
    })

    assert.equal(isDead, true)
  })

  test('起動時刻の1分より前に作られていれば、同じ PID のプロセスが動いていても死んでいる（再起動で PID が再利用される）', () => {
    const sut = isLockDead

    const isDead = sut({
      lockFileContent: buildLockFileContentCreatedAt(-61),
      isProcessRunning: () => true,
      currentBoot: buildCurrentBoot()
    })

    assert.equal(isDead, true)
  })

  test('起動時刻の引き方のずれ（1分）ちょうどまでなら、起動より前に見えても死んだとはみなさない', () => {
    const sut = isLockDead

    const isDead = sut({
      lockFileContent: buildLockFileContentCreatedAt(-60),
      isProcessRunning: () => true,
      currentBoot: buildCurrentBoot()
    })

    assert.equal(isDead, false)
  })

  test('起動の ID が同じなら、時計が進んで起動より前に見えても死んだとはみなさない（一時停止を数えない VM）', () => {
    const sut = isLockDead

    const isDead = sut({
      lockFileContent: buildLockFileContentCreatedAt(-3600, { bootId: CURRENT_BOOT_ID }),
      isProcessRunning: () => true,
      currentBoot: buildCurrentBoot({ bootId: CURRENT_BOOT_ID })
    })

    assert.equal(isDead, false)
  })

  test('起動の ID が違えば、起動後に作られたように見えても死んでいる', () => {
    const sut = isLockDead

    const isDead = sut({
      lockFileContent: buildLockFileContentCreatedAt(3600, { bootId: 'previous-boot' }),
      isProcessRunning: () => true,
      currentBoot: buildCurrentBoot({ bootId: CURRENT_BOOT_ID })
    })

    assert.equal(isDead, true)
  })

  test('ロックに起動の ID が無ければ、いまの起動の ID を引けても起動時刻で見分ける', () => {
    const sut = isLockDead

    const isDead = sut({
      lockFileContent: buildLockFileContentCreatedAt(-3600),
      isProcessRunning: () => true,
      currentBoot: buildCurrentBoot({ bootId: CURRENT_BOOT_ID })
    })

    assert.equal(isDead, true)
  })

  for (const [description, lockFileContent] of [
    ['JSON でない', 'not json'],
    ['PID が無い', JSON.stringify({ createdAt: BOOTED_AT.toISOString() })],
    ['PID が正でない', JSON.stringify({ pid: 0, createdAt: BOOTED_AT.toISOString() })],
    ['作った時刻が読めない', JSON.stringify({ pid: HOLDER_PID, createdAt: 'yesterday' })]
  ]) {
    test(`中身が読めない（${description}）ロックは死んでいる`, () => {
      const sut = isLockDead

      const isDead = sut({
        lockFileContent,
        isProcessRunning: () => true,
        currentBoot: buildCurrentBoot()
      })

      assert.equal(isDead, true)
    })
  }
})

describe('一番小さい空き番号を選ぶ', () => {
  test('使用中の番号が無ければ1番を選ぶ', () => {
    const sut = selectLowestFreeNumber

    const freeNumber = sut([])

    assert.equal(freeNumber, 1)
  })

  test('1番から続けて使用中なら、その次の番号を選ぶ', () => {
    const sut = selectLowestFreeNumber

    const freeNumber = sut([2, 1])

    assert.equal(freeNumber, 3)
  })

  test('途中に空きがあれば、大きい番号より先にその空きを選ぶ（clone を増やさない）', () => {
    const sut = selectLowestFreeNumber

    const freeNumber = sut([1, 3])

    assert.equal(freeNumber, 2)
  })
})

describe('ロックの持ち主の PID を読む', () => {
  test('作った中身からは、持ち主の PID を読める', () => {
    const sut = readLockHolderPid

    const holderPid = sut(buildLockFileContentCreatedAt(3600))

    assert.equal(holderPid, HOLDER_PID)
  })

  for (const { description, lockFileContent } of [
    { description: 'JSON でない中身', lockFileContent: 'not json' },
    {
      description: 'PID が正の整数でない中身',
      lockFileContent: buildLockFileContent({ pid: -1, createdAt: BOOTED_AT, bootId: null })
    }
  ]) {
    test(`${description}からは、PID を読めない`, () => {
      const sut = readLockHolderPid

      const holderPid = sut(lockFileContent)

      assert.equal(holderPid, null)
    })
  }
})
