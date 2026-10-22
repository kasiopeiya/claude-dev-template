// 責務: 着手した Issue のカードを着手中へ動かす判断が、どの失敗でも警告を返すだけで止まらないことを検証する。
//
// ここが壊れると、ボードが未設定の利用先や権限の足りない環境で、カードを動かせないことを理由に作業が止まる。

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { moveIssueCardToInProgress } from '../issue-card-move.mjs'

const CONFIGURED_REPOSITORY = 'kasiopeiya/claude-dev-template'
const IN_PROGRESS_STATUS_NAME = 'In progress'

/** 渡す引数を作る。指定しなかった項目は、設定したリポジトリでカードを動かせる場合の既定値になる */
function createParams(overrides = {}) {
  return {
    issueNumber: '123',
    configuredRepository: CONFIGURED_REPOSITORY,
    readCurrentRepository: () => CONFIGURED_REPOSITORY,
    moveCard: () => IN_PROGRESS_STATUS_NAME,
    ...overrides
  }
}

describe('カードを動かせる', () => {
  for (const issueNumber of ['1', '123']) {
    test(`Issue 番号が「${issueNumber}」なら、動かした先を添えて伝える`, () => {
      const sut = moveIssueCardToInProgress

      const outcome = sut(createParams({ issueNumber }))

      assert.equal(outcome.isWarning, false)
      assert.equal(
        outcome.message,
        `#${issueNumber} のカードを ${IN_PROGRESS_STATUS_NAME} へ動かしました`
      )
    })
  }

  test('設定したリポジトリと大文字小文字だけが違っても、同じリポジトリとして動かす', () => {
    const sut = moveIssueCardToInProgress

    const outcome = sut(
      createParams({ readCurrentRepository: () => CONFIGURED_REPOSITORY.toUpperCase() })
    )

    assert.equal(outcome.isWarning, false)
  })

  test('渡された番号の Issue の URL でカードを動かす', () => {
    const sut = moveIssueCardToInProgress
    const movedIssueUrls = []

    sut(
      createParams({
        moveCard: (issueUrl) => {
          movedIssueUrls.push(issueUrl)
          return IN_PROGRESS_STATUS_NAME
        }
      })
    )

    assert.deepEqual(movedIssueUrls, [`https://github.com/${CONFIGURED_REPOSITORY}/issues/123`])
  })
})

describe('動かせなければ警告だけ返す', () => {
  test('ボードが設定されていなければ、設定と今いるリポジトリを添えて警告する', () => {
    const sut = moveIssueCardToInProgress
    const movedIssueUrls = []

    const outcome = sut(
      createParams({
        readCurrentRepository: () => 'someone/other-repository',
        moveCard: (issueUrl) => movedIssueUrls.push(issueUrl)
      })
    )

    assert.equal(outcome.isWarning, true)
    assert.match(outcome.message, /someone\/other-repository/)
    assert.deepEqual(movedIssueUrls, [])
  })

  test('ボードを操作する権限が足りなければ、許可するコマンドを案内する', () => {
    const sut = moveIssueCardToInProgress
    const missingScopeError = new Error(
      'gh project item-add が失敗しました (exit 1)\nerror: your authentication token is missing required scopes [project]'
    )

    const outcome = sut(
      createParams({
        moveCard: () => {
          throw missingScopeError
        }
      })
    )

    assert.equal(outcome.isWarning, true)
    assert.match(outcome.message, /gh auth refresh -s project/)
  })

  test('gh がそのほかの理由で失敗したら、理由を添えて警告する', () => {
    const sut = moveIssueCardToInProgress

    const outcome = sut(
      createParams({
        moveCard: () => {
          throw new Error('「Status」に「In progress」という選択肢がありません')
        }
      })
    )

    assert.equal(outcome.isWarning, true)
    assert.match(outcome.message, /という選択肢がありません/)
  })

  test('今いるリポジトリを引けなければ、理由を添えて警告する', () => {
    const sut = moveIssueCardToInProgress
    const movedIssueUrls = []

    const outcome = sut(
      createParams({
        readCurrentRepository: () => {
          throw new Error('gh repo view が失敗しました (exit 1)\nerror: not logged in')
        },
        moveCard: (issueUrl) => movedIssueUrls.push(issueUrl)
      })
    )

    assert.equal(outcome.isWarning, true)
    assert.match(outcome.message, /not logged in/)
    assert.deepEqual(movedIssueUrls, [])
  })
})

describe('Issue 番号を読めなければ使い方を返す', () => {
  for (const issueNumber of [undefined, '', 'abc', '-1', '0', '12.5']) {
    test(`Issue 番号が「${issueNumber}」なら、カードを動かさず使い方を警告する`, () => {
      const sut = moveIssueCardToInProgress
      const movedIssueUrls = []

      const outcome = sut(
        createParams({ issueNumber, moveCard: (issueUrl) => movedIssueUrls.push(issueUrl) })
      )

      assert.equal(outcome.isWarning, true)
      assert.match(outcome.message, /npm run move-issue-card -- 123/)
      assert.deepEqual(movedIssueUrls, [])
    })
  }
})
