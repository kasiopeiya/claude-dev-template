// 責務: Windows で npm・claude が npm-shim（.cmd）解決漏れにより ENOENT になる回帰を防ぐ。

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { resolveCommand } from '../shell.mjs'

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

describe('コマンド名の解決', () => {
  test('Windows では npm-shim 配布のコマンドを .cmd に解決する', () => {
    const sut = resolveCommand

    withPlatform('win32', () => {
      assert.equal(sut('npm'), 'npm.cmd')
      assert.equal(sut('claude'), 'claude.cmd')
    })
  })

  test('Windows でもネイティブ配布のコマンドはそのまま解決する', () => {
    const sut = resolveCommand

    withPlatform('win32', () => {
      assert.equal(sut('gh'), 'gh')
      assert.equal(sut('git'), 'git')
    })
  })

  test('Windows 以外では npm をそのまま解決する', () => {
    const sut = resolveCommand

    withPlatform('darwin', () => {
      assert.equal(sut('npm'), 'npm')
    })
  })
})
