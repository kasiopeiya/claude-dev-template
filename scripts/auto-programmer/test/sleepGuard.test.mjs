// 責務: OS ごとに選ぶスリープ抑止コマンドが、対象プロセスの生存に紐づいたままであることを検証する。
//
// ここが壊れると、抑止コマンドが index.mjs より長生きしてマシンが眠らなくなるか、逆に
// 起動されずに壁時計タイムアウトがスリープ中も進み、無人実行が黙って打ち切られる。

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { describeSleepGuardExit, resolveSleepGuardLaunch } from '../sleepGuard.mjs'

const TARGET_PID = 4321

describe('スリープ抑止コマンドの選択', () => {
  test('macOS では caffeinate を、対象 pid の生存に紐づけて起動する', () => {
    const sut = resolveSleepGuardLaunch

    const launch = sut('darwin', TARGET_PID)

    assert.deepEqual(launch, { command: 'caffeinate', args: ['-i', '-w', String(TARGET_PID)] })
  })

  test('Windows では powershell に -TargetPid で対象 pid を渡す', () => {
    const sut = resolveSleepGuardLaunch

    const launch = sut('win32', TARGET_PID)

    assert.equal(launch.command, 'powershell.exe')
    assert.deepEqual(launch.args.slice(-2), ['-TargetPid', String(TARGET_PID)])
    assert.ok(launch.args.at(-3).endsWith('sleepGuard.ps1'))
  })

  test('Linux などスリープの影響を受けない OS では何も起動しない', () => {
    const sut = resolveSleepGuardLaunch

    const launch = sut('linux', TARGET_PID)

    assert.equal(launch, null)
  })
})

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
