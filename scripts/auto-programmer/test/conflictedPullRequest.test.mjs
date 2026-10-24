// 責務: 実行記録と open な PR の一覧から、衝突を解かせる PR が正しく選ばれ、ロック後の読み直しで飛ばす理由が決まることを検証する。
//
// ここが壊れると、衝突で止まった PR が誰にも直されずに残るか、人間や別の仕組みが手を入れたブランチを AI が無人で
// 走らせて push するか、解けずに離脱した PR を何度も解かせ直す。

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  collectOwnPullRequestsByUrl,
  findReasonNotToResolveConflict,
  selectConflictedOwnPullRequests
} from '../conflictedPullRequest.mjs'

const PULL_REQUEST_URL_PREFIX = 'https://github.com/owner/repo/pull/'

/** 実行記録の1件を作る。CI を待った commit を指定しなければ、CI を待たなかった記録になる */
function createRunRecord({ issueNumber, pullRequestNumber, waitedHeadShas = [] }) {
  return {
    issueNumber,
    pullRequestUrl: `${PULL_REQUEST_URL_PREFIX}${pullRequestNumber}`,
    ciRuns: waitedHeadShas.map((headSha) => ({ headSha }))
  }
}

/** open な PR を作る。指定しなかった項目は、衝突している PR の既定値になる */
function createOpenPullRequest({ pullRequestNumber, ...overrides }) {
  return {
    number: pullRequestNumber,
    url: `${PULL_REQUEST_URL_PREFIX}${pullRequestNumber}`,
    headRefName: 'feat/issue-1',
    mergeable: 'CONFLICTING',
    ...overrides
  }
}

describe('実行記録から、このツールが作った PR を集める', () => {
  test('PR の URL ごとに、Issue 番号と、最後に CI を待った commit を集める', () => {
    const sut = collectOwnPullRequestsByUrl
    const runRecords = [
      createRunRecord({ issueNumber: 10, pullRequestNumber: 101, waitedHeadShas: ['aaa', 'bbb'] })
    ]

    const ownPullRequestsByUrl = sut(runRecords)

    assert.deepEqual(
      ownPullRequestsByUrl,
      new Map([[`${PULL_REQUEST_URL_PREFIX}101`, { issueNumber: 10, lastWaitedHeadSha: 'bbb' }]])
    )
  })

  test('同じ PR の記録が何件もあれば、後の記録の commit を採る', () => {
    const sut = collectOwnPullRequestsByUrl
    const runRecords = [
      createRunRecord({ issueNumber: 10, pullRequestNumber: 101, waitedHeadShas: ['aaa'] }),
      createRunRecord({ issueNumber: 10, pullRequestNumber: 101, waitedHeadShas: ['ccc'] })
    ]

    const ownPullRequestsByUrl = sut(runRecords)

    assert.equal(ownPullRequestsByUrl.get(`${PULL_REQUEST_URL_PREFIX}101`).lastWaitedHeadSha, 'ccc')
  })

  test('後の記録が CI を待っていなければ、前の記録の commit を残す', () => {
    const sut = collectOwnPullRequestsByUrl
    const runRecords = [
      createRunRecord({ issueNumber: 10, pullRequestNumber: 101, waitedHeadShas: ['aaa'] }),
      createRunRecord({ issueNumber: 10, pullRequestNumber: 101 })
    ]

    const ownPullRequestsByUrl = sut(runRecords)

    assert.equal(ownPullRequestsByUrl.get(`${PULL_REQUEST_URL_PREFIX}101`).lastWaitedHeadSha, 'aaa')
  })

  test('CI を待たなかった記録の PR は、最後に CI を待った commit を持たない', () => {
    const sut = collectOwnPullRequestsByUrl
    const runRecords = [createRunRecord({ issueNumber: 10, pullRequestNumber: 101 })]

    const ownPullRequestsByUrl = sut(runRecords)

    assert.equal(ownPullRequestsByUrl.get(`${PULL_REQUEST_URL_PREFIX}101`).lastWaitedHeadSha, null)
  })

  test('PR の URL が残っていない記録は飛ばす', () => {
    const sut = collectOwnPullRequestsByUrl
    const runRecords = [
      { issueNumber: 10, pullRequestUrl: '' },
      { issueNumber: 11, pullRequestUrl: null }
    ]

    const ownPullRequestsByUrl = sut(runRecords)

    assert.equal(ownPullRequestsByUrl.size, 0)
  })

  test('Issue 番号が整数でない記録は飛ばす', () => {
    const sut = collectOwnPullRequestsByUrl
    const runRecords = [{ issueNumber: '10', pullRequestUrl: `${PULL_REQUEST_URL_PREFIX}101` }]

    const ownPullRequestsByUrl = sut(runRecords)

    assert.equal(ownPullRequestsByUrl.size, 0)
  })
})

describe('衝突を解かせる PR を選ぶ', () => {
  test('実行記録にあり、衝突している PR を、Issue 番号・ブランチ名・最後に CI を待った commit を添えて選ぶ', () => {
    const sut = selectConflictedOwnPullRequests
    const ownPullRequestsByUrl = new Map([
      [`${PULL_REQUEST_URL_PREFIX}101`, { issueNumber: 10, lastWaitedHeadSha: 'bbb' }]
    ])

    const candidates = sut({
      openPullRequests: [
        createOpenPullRequest({ pullRequestNumber: 101, headRefName: 'feat/issue-10' })
      ],
      ownPullRequestsByUrl
    })

    assert.deepEqual(candidates, [
      {
        pullRequestNumber: 101,
        pullRequestUrl: `${PULL_REQUEST_URL_PREFIX}101`,
        branchName: 'feat/issue-10',
        issueNumber: 10,
        lastWaitedHeadSha: 'bbb'
      }
    ])
  })

  test('実行記録に無い PR（人間が対話で作った PR）は、衝突していても選ばない', () => {
    const sut = selectConflictedOwnPullRequests
    const ownPullRequestsByUrl = new Map([
      [`${PULL_REQUEST_URL_PREFIX}101`, { issueNumber: 10, lastWaitedHeadSha: 'bbb' }]
    ])

    const candidates = sut({
      openPullRequests: [createOpenPullRequest({ pullRequestNumber: 102 })],
      ownPullRequestsByUrl
    })

    assert.deepEqual(candidates, [])
  })

  test('衝突していない PR は選ばない', () => {
    const sut = selectConflictedOwnPullRequests
    const ownPullRequestsByUrl = new Map([
      [`${PULL_REQUEST_URL_PREFIX}101`, { issueNumber: 10, lastWaitedHeadSha: 'bbb' }]
    ])

    const candidates = sut({
      openPullRequests: [createOpenPullRequest({ pullRequestNumber: 101, mergeable: 'MERGEABLE' })],
      ownPullRequestsByUrl
    })

    assert.deepEqual(candidates, [])
  })

  test('GitHub がまだ衝突を計算していない PR は、次の巡回に回して選ばない', () => {
    const sut = selectConflictedOwnPullRequests
    const ownPullRequestsByUrl = new Map([
      [`${PULL_REQUEST_URL_PREFIX}101`, { issueNumber: 10, lastWaitedHeadSha: 'bbb' }]
    ])

    const candidates = sut({
      openPullRequests: [createOpenPullRequest({ pullRequestNumber: 101, mergeable: 'UNKNOWN' })],
      ownPullRequestsByUrl
    })

    assert.deepEqual(candidates, [])
  })

  test('PR 番号の小さい順に並べる', () => {
    const sut = selectConflictedOwnPullRequests
    const ownPullRequestsByUrl = new Map([
      [`${PULL_REQUEST_URL_PREFIX}101`, { issueNumber: 10, lastWaitedHeadSha: 'bbb' }],
      [`${PULL_REQUEST_URL_PREFIX}102`, { issueNumber: 11, lastWaitedHeadSha: 'ddd' }]
    ])

    const candidates = sut({
      openPullRequests: [
        createOpenPullRequest({ pullRequestNumber: 102 }),
        createOpenPullRequest({ pullRequestNumber: 101 })
      ],
      ownPullRequestsByUrl
    })

    assert.deepEqual(
      candidates.map(({ pullRequestNumber }) => pullRequestNumber),
      [101, 102]
    )
  })
})

describe('ロック後の読み直しで、衝突を解かせずに飛ばす理由を決める', () => {
  /** 読み直した PR と Issue を作る。指定しなかった項目は、解かせてよい状態の既定値になる */
  function createRereadPullRequestAndIssue({ pullRequest = {}, issue = {}, ...overrides } = {}) {
    return {
      pullRequest: { state: 'OPEN', mergeable: 'CONFLICTING', headSha: 'bbb', ...pullRequest },
      issue: { number: 1, state: 'OPEN', labelNames: ['ai-fixable'], ...issue },
      lastWaitedHeadSha: 'bbb',
      needsHumanCheckLabel: 'needs-human-check',
      ...overrides
    }
  }

  test('PR が open で衝突していて、head が最後に CI を待った commit のままで、Issue が open で印も無ければ解かせる', () => {
    const sut = findReasonNotToResolveConflict

    const reason = sut(createRereadPullRequestAndIssue())

    assert.equal(reason, null)
  })

  test('他のプロセスが解いた後で、もう衝突していなければ飛ばす', () => {
    const sut = findReasonNotToResolveConflict

    const reason = sut(createRereadPullRequestAndIssue({ pullRequest: { mergeable: 'MERGEABLE' } }))

    assert.match(reason, /もう衝突していません/)
  })

  test('PR がマージされた・閉じられた後なら飛ばす', () => {
    const sut = findReasonNotToResolveConflict

    const reason = sut(createRereadPullRequestAndIssue({ pullRequest: { state: 'CLOSED' } }))

    assert.match(reason, /もう open ではありません/)
  })

  test('最後に CI を待った commit の後に、人間か別の仕組みが push していれば飛ばす', () => {
    const sut = findReasonNotToResolveConflict

    const reason = sut(
      createRereadPullRequestAndIssue({
        pullRequest: { headSha: 'eee' },
        lastWaitedHeadSha: 'bbb'
      })
    )

    assert.match(reason, /別の push があります/)
  })

  test('最後に CI を待った commit が記録に無ければ、中身を確かめられないので飛ばす', () => {
    const sut = findReasonNotToResolveConflict

    const reason = sut(createRereadPullRequestAndIssue({ lastWaitedHeadSha: null }))

    assert.match(reason, /CI を待った記録が無い/)
  })

  test('Issue が閉じていれば飛ばす', () => {
    const sut = findReasonNotToResolveConflict

    const reason = sut(createRereadPullRequestAndIssue({ issue: { number: 10, state: 'CLOSED' } }))

    assert.match(reason, /#10 が閉じています/)
  })

  test('解けずに離脱して needs-human-check が付いた Issue の PR は、人間が見るまで飛ばす', () => {
    const sut = findReasonNotToResolveConflict

    const reason = sut(
      createRereadPullRequestAndIssue({
        issue: { labelNames: ['ai-fixable', 'needs-human-check'] },
        needsHumanCheckLabel: 'needs-human-check'
      })
    )

    assert.match(reason, /needs-human-check が付いています/)
  })
})
