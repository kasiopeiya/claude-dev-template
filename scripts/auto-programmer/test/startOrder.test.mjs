// 責務: 候補の選別と着手順が、ブロッカーの実測と段番号どおりに決まることを検証する。
//
// ここが壊れると、無人のツールが未完のブロッカーを待たずに着手し、手戻りする PR が
// 誰にも見られずにできる。

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { extractBlockerIssueNumbers, selectStartableIssues } from '../startOrder.mjs'

/** ブロッカー節だけを変えた Issue 本文を作る */
function createBodyWithBlockers(blockerLines) {
  return ['## 対応方針', '', '本文', '', '## ブロッカー', '', ...blockerLines, ''].join('\n')
}

/** 候補の Issue を作る。指定しなかった項目は段番号・ブロッカー無しの既定値になる */
function createCandidate(overrides = {}) {
  return { number: 1, title: 'タイトル', body: '', ...overrides }
}

describe('ブロッカーの抽出', () => {
  test('ブロッカー節の各行の先頭にある Issue 番号を返す', () => {
    const sut = extractBlockerIssueNumbers
    const body = createBodyWithBlockers([
      '- #480 — 骨格を作る Issue',
      '- #12 (closed) — 先に終わっている Issue'
    ])

    const blockerNumbers = sut(body)

    assert.deepEqual(blockerNumbers, [480, 12])
  })

  test('説明文の中に出てくる Issue 番号はブロッカーに含めない', () => {
    const sut = extractBlockerIssueNumbers
    const body = createBodyWithBlockers(['- #480 — #999 から分かれた Issue'])

    const blockerNumbers = sut(body)

    assert.deepEqual(blockerNumbers, [480])
  })

  test('ブロッカー節より後の節にある箇条書きはブロッカーに含めない', () => {
    const sut = extractBlockerIssueNumbers
    const body = `${createBodyWithBlockers(['- #480 — 骨格'])}\n## 関連\n\n- #500 — 参考`

    const blockerNumbers = sut(body)

    assert.deepEqual(blockerNumbers, [480])
  })

  test('コードブロックの中に書かれたブロッカー節は読まない', () => {
    const sut = extractBlockerIssueNumbers
    const body = `\`\`\`markdown\n## ブロッカー\n\n- #123 — 書き方の例\n\`\`\`\n\n${createBodyWithBlockers(['- #480 — 骨格'])}`

    const blockerNumbers = sut(body)

    assert.deepEqual(blockerNumbers, [480])
  })

  test('ブロッカー節が無い本文からは空配列を返す', () => {
    const sut = extractBlockerIssueNumbers

    assert.deepEqual(sut('## 対応方針\n\n- #480 — 参考'), [])
    assert.deepEqual(sut(undefined), [])
  })

  test('ブロッカー節になしと書かれた本文からは空配列を返す（平文・箇条書きのどちらでも）', () => {
    const sut = extractBlockerIssueNumbers

    assert.deepEqual(sut(createBodyWithBlockers(['なし（すぐ着手できる）'])), [])
    assert.deepEqual(sut(createBodyWithBlockers(['- なし（すぐ着手できる）'])), [])
  })

  test('ブロッカー節に番号を読めない箇条書きの行があれば null を返す', () => {
    const sut = extractBlockerIssueNumbers

    assert.equal(sut(createBodyWithBlockers(['1. #480 — 番号付きの箇条書き'])), null)
    assert.equal(sut(createBodyWithBlockers(['- [#480](https://example.com) — リンク'])), null)
    assert.equal(sut(createBodyWithBlockers(['- owner/repo#480 — 別リポジトリ'])), null)
  })
})

describe('着手できる Issue の選別', () => {
  test('未解消のブロッカーが残っている Issue は候補から外れる', () => {
    const sut = selectStartableIssues
    const blocked = createCandidate({ number: 10, body: createBodyWithBlockers(['- #5 — 未完']) })
    const unblocked = createCandidate({ number: 11 })

    const startable = sut([blocked, unblocked], new Set([5]))

    assert.deepEqual(
      startable.map(({ number }) => number),
      [11]
    )
  })

  test('ブロッカーが全部解消済みの Issue は候補に残る', () => {
    const sut = selectStartableIssues
    const unblocked = createCandidate({
      number: 10,
      body: createBodyWithBlockers(['- #5 (closed) — 完了', '- #6 — 完了'])
    })

    const startable = sut([unblocked], new Set([7]))

    assert.deepEqual(
      startable.map(({ number }) => number),
      [10]
    )
  })

  test('ブロッカー節を読めない Issue は候補から外れる', () => {
    const sut = selectStartableIssues
    const unreadable = createCandidate({
      number: 10,
      body: createBodyWithBlockers(['- [#5](https://example.com) — リンク'])
    })

    const startable = sut([unreadable], new Set())

    assert.deepEqual(startable, [])
  })
})

describe('着手順', () => {
  test('段番号の小さい順に並び、同じ段では Issue 番号の小さい順になる', () => {
    const sut = selectStartableIssues
    const candidates = [
      createCandidate({ number: 30, title: '2. 後段' }),
      createCandidate({ number: 20, title: '1. 前段の後番' }),
      createCandidate({ number: 40, title: '10. 最後段' }),
      createCandidate({ number: 10, title: '1. 前段の先番' })
    ]

    const startable = sut(candidates, new Set())

    assert.deepEqual(
      startable.map(({ number }) => number),
      [10, 20, 30, 40]
    )
  })

  test('段番号が範囲で書かれた Issue は範囲の小さいほうの段として並ぶ', () => {
    const sut = selectStartableIssues
    const candidates = [
      createCandidate({ number: 10, title: '2. 後段' }),
      createCandidate({ number: 20, title: '1〜3. 親' })
    ]

    const startable = sut(candidates, new Set())

    assert.deepEqual(
      startable.map(({ number }) => number),
      [20, 10]
    )
  })

  test('段番号の無い Issue は段番号のある Issue より後に並ぶ', () => {
    const sut = selectStartableIssues
    const candidates = [
      createCandidate({ number: 10, title: '段番号なし' }),
      createCandidate({ number: 20, title: '3. 段あり' })
    ]

    const startable = sut(candidates, new Set())

    assert.deepEqual(
      startable.map(({ number }) => number),
      [20, 10]
    )
  })

  test('段番号の無い Issue 同士は Issue 番号の小さい順になる', () => {
    const sut = selectStartableIssues
    const candidates = [
      createCandidate({ number: 30, title: '段番号なし' }),
      createCandidate({ number: 10, title: '段番号なし' }),
      createCandidate({ number: 20, title: '段番号なし' })
    ]

    const startable = sut(candidates, new Set())

    assert.deepEqual(
      startable.map(({ number }) => number),
      [10, 20, 30]
    )
  })
})
