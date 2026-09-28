// 責務: 画面へ出す1行の組み立てが、時刻・レベル記号を落とさず、原因の1行を埋もれさせないことを検証する。
//
// ここが壊れると、無人実行の画面から「いつ」「正常か異常か」が読めなくなり、起動した人間が
// 異常に気づけないまま着手待ちのカードを空振りで使い切る。

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildIssueBannerText,
  buildMessageLines,
  collapseToSingleLine,
  formatClockTime,
  formatElapsedTime
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
})

describe('区切りバナー', () => {
  test('Issue 番号とタイトルを罫線で挟む', () => {
    const sut = buildIssueBannerText

    const banner = sut({ issueNumber: 123, title: '表示層を入れる' })

    assert.equal(banner, '── #123 表示層を入れる ──')
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
