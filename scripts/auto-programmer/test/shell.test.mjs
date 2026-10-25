// 責務: 外部コマンドの起動まわりの回帰を防ぐ。次の2つを検証する。
// - Windows で claude・npm が npm-shim（.cmd）解決漏れにより ENOENT/EINVAL になる回帰
// - claude セッションの時間切れで、SIGTERM を無視する子が居ても待ちが終わること
//
// claude はインストール方法により .exe にも .cmd にもなるため、コマンド名の決め打ちでは
// 検証できない。ENOENT を受けて .cmd + shell:true へフォールバックし、引数を割れないよう囲む「振る舞い」だけを検証する。

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { runStreamingAsync, spawnWithWindowsShimFallback } from '../shell.mjs'

/** テスト中だけ process.platform を差し替え、終わったら元に戻す */
function withPlatform(platform, callback) {
  const original = process.platform
  // eslint-disable-next-line id-denylist -- Object.defineProperty の記述子のキーは仕様が決めた名前
  Object.defineProperty(process, 'platform', { value: platform })
  try {
    callback()
  } finally {
    // eslint-disable-next-line id-denylist -- Object.defineProperty の記述子のキーは仕様が決めた名前
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
    const spawnWithCommand = (command, args, extraOptions) => {
      calls.push({ command, args, extraOptions })
      return command.endsWith('.cmd') ? { error: null, status: 0 } : createEnoentResult()
    }

    withPlatform('win32', () => {
      const result = sut(spawnWithCommand, 'claude', ['-p', '/auto-dev 123'])

      assert.deepEqual(calls, [
        { command: 'claude', args: ['-p', '/auto-dev 123'], extraOptions: {} },
        // shell 経由では引数が空白でつながれるので、空白を含む引数が割れないよう囲む
        { command: 'claude.cmd', args: ['"-p"', '"/auto-dev 123"'], extraOptions: { shell: true } }
      ])
      assert.equal(result.error, null)
    })
  })

  test('Windows で .cmd に渡すとき、cmd.exe のクォートで守れない文字を含む引数は拒む', () => {
    const sut = spawnWithWindowsShimFallback
    const calledCommands = []
    const spawnWithCommand = (command) => {
      calledCommands.push(command)
      return createEnoentResult()
    }

    withPlatform('win32', () => {
      for (const unsafeArg of ['a"b', '%PATH%', 'line1\nline2']) {
        assert.throws(() => sut(spawnWithCommand, 'npm', [unsafeArg]))
      }
      assert.ok(calledCommands.every((command) => command === 'npm'))
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
      sut(spawnWithCommand, 'claude', [])

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
      const result = sut(spawnWithCommand, 'claude', [])

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
      const result = sut(spawnWithCommand, 'claude', [])

      assert.deepEqual(calledCommands, ['claude'])
      assert.equal(result, enoentResult)
    })
  })
})

// Windows は SIGTERM の概念が無く taskkill で強制終了するので、SIGTERM を無視する子を作れない
const SKIP_ON_WINDOWS =
  process.platform === 'win32' ? 'Windows には SIGTERM を無視する子が作れない' : false

// 時間切れを子が SIGTERM のハンドラを登録した後に起こすための余裕（Node の起動に掛かる時間より長くとる）
const TIMEOUT_AFTER_HANDLER_REGISTERED_MS = 1000

// 猶予を含めても終わる見込みの上限。これを過ぎたら待ちが終わっていないとして落とす
const TEST_TIMEOUT_MS = 15000

// 落ちたテストの子が居残らないよう、子は自分でもテストの上限より後に終わる
const TEST_CHILD_LIFETIME_MS = 30000

/** runStreamingAsync に渡す、画面更新も中継も要らないときの受け皿 */
const ignoreProgress = { onTick: () => {}, onOutput: () => {} }

describe('claude セッションの時間切れ', () => {
  test(
    'SIGTERM を無視する子でも、猶予の後に強制終了して待ちが終わる',
    { timeout: TEST_TIMEOUT_MS, skip: SKIP_ON_WINDOWS },
    async () => {
      const sut = runStreamingAsync
      const stubbornChildScript = `process.on('SIGTERM', () => {}); setTimeout(() => {}, ${TEST_CHILD_LIFETIME_MS})`

      const result = await sut(process.execPath, ['-e', stubbornChildScript], {
        timeoutMs: TIMEOUT_AFTER_HANDLER_REGISTERED_MS,
        ...ignoreProgress
      })

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

      const result = await sut(process.execPath, ['-e', cleaningChildScript], {
        timeoutMs: TIMEOUT_AFTER_HANDLER_REGISTERED_MS,
        onTick: () => {},
        onOutput: (_streamName, chunk) => output.push(chunk.toString())
      })

      assert.equal(result.signal, 'SIGTERM')
      assert.match(output.join(''), /cleaned up/)
    }
  )
})
