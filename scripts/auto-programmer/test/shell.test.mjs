// 責務: Windows で claude・npm が npm-shim（.cmd）解決漏れにより ENOENT/EINVAL になる回帰を防ぐ。
//
// claude はインストール方法により .exe にも .cmd にもなるため、コマンド名の決め打ちでは
// 検証できない。ENOENT を受けて .cmd + shell:true へフォールバックする「振る舞い」だけを検証する。

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { spawnWithWindowsShimFallback } from '../shell.mjs'

/** テスト中だけ process.platform を差し替え、終わったら元に戻す */
function withPlatform(platform, callback) {
  const original = process.platform
  Object.defineProperty(process, 'platform', { value: platform })
  try {
    callback()
  } finally {
    Object.defineProperty(process, 'platform', { value: original })
  }
}

/** spawnSync が ENOENT で失敗したことを表す最小限の戻り値 */
function createEnoentResult() {
  return { error: Object.assign(new Error('spawnSync npm ENOENT'), { code: 'ENOENT' }) }
}

describe('Windows での npm-shim フォールバック', () => {
  test('Windows で ENOENT のとき、.cmd を shell 経由で実行し直す', () => {
    const sut = spawnWithWindowsShimFallback
    const calls = []
    const spawnWithCommand = (command, extraOptions) => {
      calls.push({ command, extraOptions })
      return command.endsWith('.cmd') ? { error: null, status: 0 } : createEnoentResult()
    }

    withPlatform('win32', () => {
      const result = sut(spawnWithCommand, 'claude')

      assert.deepEqual(calls, [
        { command: 'claude', extraOptions: {} },
        { command: 'claude.cmd', extraOptions: { shell: true } }
      ])
      assert.equal(result.error, null)
    })
  })

  test('Windows で1回目が成功したとき、.cmd では実行し直さない', () => {
    const sut = spawnWithWindowsShimFallback
    const calledCommands = []
    const spawnWithCommand = (command) => {
      calledCommands.push(command)
      return { error: null, status: 0 }
    }

    withPlatform('win32', () => {
      sut(spawnWithCommand, 'claude')

      assert.deepEqual(calledCommands, ['claude'])
    })
  })

  test('Windows で ENOENT 以外のエラーのとき、.cmd では実行し直さない', () => {
    const sut = spawnWithWindowsShimFallback
    const calledCommands = []
    const permissionDeniedResult = {
      error: Object.assign(new Error('spawnSync claude EACCES'), { code: 'EACCES' })
    }
    const spawnWithCommand = (command) => {
      calledCommands.push(command)
      return permissionDeniedResult
    }

    withPlatform('win32', () => {
      const result = sut(spawnWithCommand, 'claude')

      assert.deepEqual(calledCommands, ['claude'])
      assert.equal(result, permissionDeniedResult)
    })
  })

  test('Windows 以外では ENOENT でも .cmd では実行し直さない', () => {
    const sut = spawnWithWindowsShimFallback
    const calledCommands = []
    const enoentResult = createEnoentResult()
    const spawnWithCommand = (command) => {
      calledCommands.push(command)
      return enoentResult
    }

    withPlatform('darwin', () => {
      const result = sut(spawnWithCommand, 'claude')

      assert.deepEqual(calledCommands, ['claude'])
      assert.equal(result, enoentResult)
    })
  })
})
