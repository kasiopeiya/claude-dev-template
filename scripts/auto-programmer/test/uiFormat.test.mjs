// 責務: 画面へ出す行の組み立てが、時刻・レベル記号を落とさず、原因の1行を埋もれさせず、
// その場更新のステータス行を壊さないことを検証する。
//
// ここが壊れると、無人実行の画面から「いつ」「正常か異常か」が読めなくなり、起動した人間が
// 異常に気づけないまま着手待ちのカードを空振りで使い切る。

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  CHILD_OUTPUT_GUTTER,
  alignLabeledValues,
  buildIssueBannerText,
  buildMessageLines,
  buildSessionProgressText,
  buildStatusLineText,
  collapseToSingleLine,
  formatClockTime,
  formatElapsedTime,
  pickSpinnerFrame,
  prefixChunkLines
} from '../uiFormat.mjs'

describe('時刻の整形', () => {
  test('1桁の時・分・秒を2桁に揃える', () => {
    const sut = formatClockTime

    const clockTime = sut(new Date(2026, 0, 2, 3, 4, 5))

    assert.equal(clockTime, '03:04:05')
  })
})

describe('所要時間の整形', () => {
  test('1分に満たなければ秒だけで言う', () => {
    const sut = formatElapsedTime

    const elapsed = sut(45_000)

    assert.equal(elapsed, '45秒')
  })

  test('1分以上1時間未満なら分と秒で言う', () => {
    const sut = formatElapsedTime

    const elapsed = sut(750_000)

    assert.equal(elapsed, '12分30秒')
  })

  test('ちょうど1分なら分と秒で言う', () => {
    const sut = formatElapsedTime

    const elapsed = sut(60_000)

    assert.equal(elapsed, '1分0秒')
  })

  test('1時間以上なら時間・分・秒で言う', () => {
    const sut = formatElapsedTime

    const elapsed = sut(3_785_000)

    assert.equal(elapsed, '1時間3分5秒')
  })

  test('負の値は0秒として扱う', () => {
    const sut = formatElapsedTime

    const elapsed = sut(-1000)

    assert.equal(elapsed, '0秒')
  })
})

describe('メッセージ行の組み立て', () => {
  test('時刻とレベル記号を先頭に付ける', () => {
    const sut = buildMessageLines

    const lines = sut({ clockTime: '01:02:03', symbol: 'ℹ', message: 'ブランチ: feature/x' })

    assert.deepEqual(lines, ['01:02:03 ℹ ブランチ: feature/x'])
  })

  test('改行を含むメッセージは、どの行にも時刻とレベル記号を付ける', () => {
    const sut = buildMessageLines

    const lines = sut({ clockTime: '01:02:03', symbol: '✗', message: '失敗しました\nstderr の行' })

    assert.deepEqual(lines, ['01:02:03 ✗ 失敗しました', '01:02:03 ✗ stderr の行'])
  })

  test('時刻とレベル記号を消せる制御文字を落とす', () => {
    const sut = buildMessageLines

    const lines = sut({ clockTime: '01:02:03', symbol: 'ℹ', message: '偽の行\r\u001b[2K本物' })

    assert.deepEqual(lines, ['01:02:03 ℹ 偽の行[2K本物'])
  })

  test('本文の色付けは制御文字を落とした後に掛け、色の制御文字を残す', () => {
    const sut = buildMessageLines

    const lines = sut({
      clockTime: '01:02:03',
      symbol: '⚠',
      message: '警告\r',
      styleLineText: (text) => `\u001b[33m${text}\u001b[39m`
    })

    assert.deepEqual(lines, ['01:02:03 ⚠ \u001b[33m警告\u001b[39m'])
  })
})

describe('セッション中のステータス行の本文', () => {
  const limitMs = 60 * 60_000

  test('経過を上限と同じ桁数に揃え、秒を2桁にする', () => {
    const sut = buildSessionProgressText

    const text = sut({ elapsedMs: 151_000, limitMs })

    assert.equal(text, '実行中  [░░░░░░░░░░]   2:31 / 60:00')
  })

  test('進み具合に応じて10マスのうちを塗る', () => {
    const sut = buildSessionProgressText

    const text = sut({ elapsedMs: 27 * 60_000, limitMs })

    assert.equal(text, '実行中  [████░░░░░░]  27:00 / 60:00')
  })

  test('上限を超えたら、バーは全部塗り、経過は時間に繰り上げない', () => {
    const sut = buildSessionProgressText

    const text = sut({ elapsedMs: 61 * 60_000 + 5_000, limitMs })

    assert.equal(text, '実行中  [██████████]  61:05 / 60:00')
  })

  test('負の経過は0秒として扱い、バーを塗らない', () => {
    const sut = buildSessionProgressText

    const text = sut({ elapsedMs: -1000, limitMs })

    assert.equal(text, '実行中  [░░░░░░░░░░]   0:00 / 60:00')
  })
})

describe('スピナーの絵柄', () => {
  test('1秒ごとに次の絵柄へ進み、4つで一周する', () => {
    const sut = pickSpinnerFrame

    const frames = [1000, 2000, 3000, 4000, 5000].map(sut)

    assert.deepEqual(frames, ['/', '-', '\\', '|', '/'])
  })

  test('タイマーのずれで tick が前後しても同じ絵柄を選ぶ', () => {
    const sut = pickSpinnerFrame

    const frames = [1999, 2001].map(sut)

    assert.deepEqual(frames, ['-', '-'])
  })

  test('どの絵柄も ASCII である（WGL4 に無い記号は Windows で崩れる）', () => {
    const sut = pickSpinnerFrame

    const frames = [0, 1000, 2000, 3000].map(sut)

    assert.ok(frames.every((frame) => /^[\x20-\x7e]$/.test(frame)))
  })
})

describe('子の出力への罫線の差し込み', () => {
  const prefix = '│ '

  test('行頭から始まるチャンクは、先頭と各改行の直後に差し込む', () => {
    const sut = prefixChunkLines

    const result = sut({ chunk: Buffer.from('a\nb\n'), prefix, isAtLineStart: true })

    assert.equal(result.toString(), '│ a\n│ b\n')
  })

  test('行の途中から始まるチャンクは、先頭に差し込まない', () => {
    const sut = prefixChunkLines

    const result = sut({ chunk: Buffer.from('続き\n次'), prefix, isAtLineStart: false })

    assert.equal(result.toString(), '続き\n│ 次')
  })

  test('改行の後ろに1バイトだけ残るチャンクも、その前に差し込む', () => {
    const sut = prefixChunkLines

    const result = sut({ chunk: Buffer.from('a\nb'), prefix, isAtLineStart: true })

    assert.equal(result.toString(), '│ a\n│ b')
  })

  test('チャンクの境目で割れた多バイト文字を壊さない', () => {
    const sut = prefixChunkLines
    const bytes = Buffer.from('あ\nい')
    const headChunk = { chunk: bytes.subarray(0, 2), prefix, isAtLineStart: true }
    const tailChunk = { chunk: bytes.subarray(2), prefix, isAtLineStart: false }

    const result = Buffer.concat([sut(headChunk), sut(tailChunk)]).toString()

    assert.equal(result, '│ あ\n│ い')
  })

  test('罫線は時刻と空白の幅だけ空けた位置に置く', () => {
    const sut = CHILD_OUTPUT_GUTTER

    const gutterColumn = sut.indexOf('│')

    assert.equal(gutterColumn, `${formatClockTime(new Date(0))} `.length)
  })
})

describe('ステータス行の組み立て', () => {
  test('時刻・記号・メッセージを1行に並べる', () => {
    const sut = buildStatusLineText

    const line = sut({
      clockTime: '01:02:03',
      symbol: '⏳',
      message: '待機中（着手できる Issue なし）· 12回目'
    })

    assert.equal(line, '01:02:03 ⏳ 待機中（着手できる Issue なし）· 12回目')
  })

  test('改行を空白へ畳んで1行にする', () => {
    const sut = buildStatusLineText

    const line = sut({ clockTime: '01:02:03', symbol: '⏳', message: '1行目\n2行目' })

    assert.equal(line, '01:02:03 ⏳ 1行目 2行目')
  })

  test('その場更新を壊す制御文字を落とす', () => {
    const sut = buildStatusLineText

    const line = sut({ clockTime: '01:02:03', symbol: '⏳', message: '偽の行\r\u001b[2K本物' })

    assert.equal(line, '01:02:03 ⏳ 偽の行[2K本物')
  })
})

describe('区切りバナー', () => {
  test('二重罫線の行の下に、字下げしたタイトルとブランチ名を置く', () => {
    const sut = buildIssueBannerText

    const banner = sut({ issueNumber: 123, title: '表示層を入れる', branchName: 'feat/issue-123' })

    const [ruleLine, titleLine, branchLine] = banner.split('\n')
    assert.match(ruleLine, /^══ #123 ═+$/)
    assert.equal(titleLine, '   表示層を入れる')
    assert.equal(branchLine, '   ブランチ: feat/issue-123')
  })
})

describe('項目名の揃え', () => {
  test('全角の項目名は1文字を2桁に数えて、値が同じ桁から始まるようにする', () => {
    const sut = alignLabeledValues

    const lines = sut([
      { label: 'CI', value: 'success' },
      { label: '記録', value: 'runs.jsonl' }
    ])

    assert.deepEqual(lines, ['CI    success', '記録  runs.jsonl'])
  })

  test('全角の範囲の端ちょうどの文字も2桁に数える', () => {
    const sut = alignLabeledValues

    // 一（範囲の先頭 U+4E00）・｠（範囲の末尾 U+FF60）
    const lines = sut([
      { label: '\u4e00\uff60', value: 'x' },
      { label: 'abcd', value: 'y' }
    ])

    assert.deepEqual(lines, ['\u4e00\uff60  x', 'abcd  y'])
  })

  test('全角の範囲のすぐ外の文字は1桁に数える', () => {
    const sut = alignLabeledValues

    // ䷿（先頭の1つ前 U+4DFF）・｡（末尾の1つ後ろ U+FF61）
    const lines = sut([
      { label: '\u4dff\uff61', value: 'x' },
      { label: 'abcd', value: 'y' }
    ])

    assert.deepEqual(lines, ['\u4dff\uff61    x', 'abcd  y'])
  })
})

describe('1行への畳み込み', () => {
  test('原因が後ろの行にあっても落とさずつなぐ', () => {
    const sut = collapseToSingleLine

    const line = sut('gh が失敗しました (exit 1)\n\n  GraphQL: API rate limit exceeded\n')

    assert.equal(line, 'gh が失敗しました (exit 1) / GraphQL: API rate limit exceeded')
  })

  test('上限ちょうどなら何も落とさない', () => {
    const sut = collapseToSingleLine

    const line = sut('あ'.repeat(200))

    assert.equal(line, 'あ'.repeat(200))
  })

  test('上限を超えたら、原因のある末尾を残して真ん中を落とす', () => {
    const sut = collapseToSingleLine

    const line = sut(`${'頭'.repeat(250)}原因はこれ`)

    assert.equal(line, `${'頭'.repeat(60)}…${'頭'.repeat(135)}原因はこれ`)
  })

  test('中身のある行が無ければ空文字を返す', () => {
    const sut = collapseToSingleLine

    const line = sut('\n   \n')

    assert.equal(line, '')
  })
})
