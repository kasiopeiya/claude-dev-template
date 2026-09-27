// 責務: PR 本文から close 対象の Issue を拾う規則が、GitHub の `Closes #N` の解釈とずれないことを検証する。
//
// ここがずれると、閉じるべき Issue が open のまま残るか、PR 本文で言及しただけの Issue を誤って閉じる。

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { extractClosingIssueNumbers, findIssuesToClose } from './close-issues-of-merged-prs.mjs'

describe('PR 本文から close 対象の Issue 番号を取り出す', () => {
  const sut = extractClosingIssueNumbers

  test('close・fix・resolve の各活用形を大文字小文字によらず拾う', () => {
    const body =
      'Closes #1\nclosed #2\nFix #3\nfixes #4\nFIXED #5\nresolve #6\nResolves #7\nresolved #8'

    const result = sut(body)

    assert.deepEqual(result, [1, 2, 3, 4, 5, 6, 7, 8])
  })

  test('キーワードの直後のコロンを許す', () => {
    assert.deepEqual(sut('Closes: #12'), [12])
  })

  test('キーワードの無い言及は拾わない', () => {
    assert.deepEqual(sut('#10 の続き。refs #11'), [])
  })

  test('別リポジトリの Issue は拾わない', () => {
    assert.deepEqual(sut('Closes owner/repo#13'), [])
  })

  test('別の語の一部になったキーワードは拾わない', () => {
    assert.deepEqual(sut('hotfix #14\nprefixes #15'), [])
  })

  test('同じ Issue を重ねて書いても1件にまとめる', () => {
    assert.deepEqual(sut('Closes #16\nFixes #16'), [16])
  })

  test('本文が空なら何も返さない', () => {
    assert.deepEqual(sut(null), [])
  })
})

describe('close する Issue と根拠の PR を組にする', () => {
  const sut = findIssuesToClose

  test('open な Issue だけを対象にする', () => {
    const mergedPullRequests = [{ number: 100, body: 'Closes #1\nCloses #2' }]
    const openIssueNumbers = new Set([2])

    const result = sut({ mergedPullRequests, openIssueNumbers })

    assert.deepEqual(result, [{ issueNumber: 2, pullRequestNumber: 100 }])
  })

  test('同じ Issue を複数の PR が指すときは、先に出た PR を根拠にする', () => {
    const mergedPullRequests = [
      { number: 200, body: 'Closes #3' },
      { number: 199, body: 'Closes #3' }
    ]
    const openIssueNumbers = new Set([3])

    const result = sut({ mergedPullRequests, openIssueNumbers })

    assert.deepEqual(result, [{ issueNumber: 3, pullRequestNumber: 200 }])
  })
})
