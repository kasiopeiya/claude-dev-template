// 責務: スリープ抑止の子プロセスが途中で終わったとき、終了コード・シグナルに応じた警告文が出ることを検証する。
//
// ここが壊れると、抑止が起動後に落ちても警告が出ず、無人実行がスリープで黙って打ち切られても気づけない。

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { describeSleepGuardExit } from '../sleepGuard.mjs'

describe('スリープ抑止が終わったときの警告文', () => {
  test('見張る pid が消えて 0 で終わった場合は警告を出さない', () => {
    const sut = describeSleepGuardExit

    const message = sut(0, null)

    assert.equal(message, null)
  })

  test('0 以外の終了コードで終わった場合は、その終了コードを含む警告を返す', () => {
    const sut = describeSleepGuardExit

    const message = sut(1, null)

    assert.equal(message, 'スリープ抑止が途中で終わりました（終了コード 1。続行します）')
  })

  test('シグナルで終わった場合は、null を出さずにシグナル名を含む警告を返す', () => {
    const sut = describeSleepGuardExit

    const message = sut(null, 'SIGKILL')

    assert.equal(message, 'スリープ抑止が途中で終わりました（シグナル SIGKILL で終了。続行します）')
    assert.ok(!message.includes('null'))
  })
})
