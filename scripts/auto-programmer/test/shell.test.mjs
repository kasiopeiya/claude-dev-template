// 責務: claude セッションの時間切れで、SIGTERM を無視する子が居ても待ちが終わることを防ぐ。
//
// 子の SIGTERM の扱い（無視する・後片付けして終わる）は実際の node プロセスで再現する。

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { runStreamingAsync } from '../shell.mjs'

// Windows は SIGTERM の概念が無く taskkill で強制終了するので、SIGTERM を無視する子を作れない
const SKIP_ON_WINDOWS =
  process.platform === 'win32' ? 'Windows には SIGTERM を無視する子が作れない' : false

// 時間切れを子が SIGTERM のハンドラを登録した後に起こすための余裕（Node の起動に掛かる時間より長くとる）
const TIMEOUT_AFTER_HANDLER_REGISTERED_MS = 1000

// 猶予を含めても終わる見込みの上限。これを過ぎたら待ちが終わっていないとして落とす
const TEST_TIMEOUT_MS = 15000

// 落ちたテストの子が居残らないよう、子は自分でもテストの上限より後に終わる
const TEST_CHILD_LIFETIME_MS = 30000

/** runStreamingAsync に渡す、時間切れ以外の必須項目と、画面更新も中継も要らないときの受け皿 */
const createSessionOptions = (overrides) => ({
  cwd: process.cwd(),
  timeoutMs: TIMEOUT_AFTER_HANDLER_REGISTERED_MS,
  abortSignal: new AbortController().signal,
  onTick: () => {},
  onOutput: () => {},
  ...overrides
})

describe('claude セッションの時間切れ', () => {
  test(
    'SIGTERM を無視する子でも、猶予の後に強制終了して待ちが終わる',
    { timeout: TEST_TIMEOUT_MS, skip: SKIP_ON_WINDOWS },
    async () => {
      const sut = runStreamingAsync
      const stubbornChildScript = `process.on('SIGTERM', () => {}); setTimeout(() => {}, ${TEST_CHILD_LIFETIME_MS})`

      const result = await sut(
        process.execPath,
        ['-e', stubbornChildScript],
        createSessionOptions()
      )

      assert.equal(result.signal, 'SIGKILL')
    }
  )

  test(
    'SIGTERM で終わる子には、後片付けの機会を与えてから止める',
    { timeout: TEST_TIMEOUT_MS, skip: SKIP_ON_WINDOWS },
    async () => {
      const sut = runStreamingAsync
      const output = []
      const cleaningChildScript = `process.on('SIGTERM', () => { console.log('cleaned up'); process.exit(0) }); setTimeout(() => {}, ${TEST_CHILD_LIFETIME_MS})`

      const result = await sut(
        process.execPath,
        ['-e', cleaningChildScript],
        createSessionOptions({ onOutput: (_streamName, chunk) => output.push(chunk.toString()) })
      )

      assert.equal(result.signal, 'SIGTERM')
      assert.match(output.join(''), /cleaned up/)
    }
  )
})
