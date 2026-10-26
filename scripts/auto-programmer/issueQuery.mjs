// 責務: Issue と sub-issue を gh で読む口を担う。どの Issue をいつ読むか・読んだ結果で何をするかは呼び出し側が決める。
//
// 設計意図（WHY）:
// - gh の引数と戻り値の読み方を、Issue 1件単位の口としてここに置く。直すたびに、周回・ロック・子への引き継ぎの混ざった
//   index.mjs を開かずに済む。
// - 中身を判断せず、gh が返した値の形だけを整える。Issue の state・ラベルのように、読めない値を安全側へ倒すと
//   記録が嘘になるものは、倒さず投げる。
// - どのカードがこのボードのものかの見分けは board.mjs の知識なので、ここでは持たず board.mjs に聞く。
// - 呼び出し側を import しない。呼び出し側からこのモジュールへの一方向にして、循環を作らない。

import { TechnicalError } from '../lib/errors.mjs'
import { BOARD_CARD_STATUS_FIELDS, findBoardStatusName } from './board.mjs'
import { config } from './config.mjs'
import { runJson } from './shell.mjs'

// GraphQL が1つの接続（sub-issue・ラベル・カード）から一度に返せる件数の上限。sub-issue は超えていたら読み落としとして止める
const GRAPHQL_CONNECTION_FETCH_LIMIT = 100

// 1つの Issue に付けられる担当者の上限（GitHub の仕様）。この件数を読めば全員がそろう
const ISSUE_ASSIGNEE_LIMIT = 10

// gh issue view の --json は sub-issue を返さないので、GraphQL で引く。自分のログイン名（viewer）も同じ呼び出しで引く
const SUB_ISSUES_QUERY = `query($owner: String!, $name: String!, $number: Int!, $statusFieldName: String!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      subIssues(first: ${GRAPHQL_CONNECTION_FETCH_LIMIT}) {
        totalCount
        nodes {
          number
          url
          state
          repository { nameWithOwner }
          assignees(first: ${ISSUE_ASSIGNEE_LIMIT}) { nodes { login } }
          labels(first: ${GRAPHQL_CONNECTION_FETCH_LIMIT}) { nodes { name } }
          projectItems(first: ${GRAPHQL_CONNECTION_FETCH_LIMIT}) {
            nodes { ${BOARD_CARD_STATUS_FIELDS} }
          }
        }
      }
    }
  }
}`

/**
 * Issue の state とラベルを引き直す。
 *
 * @param {number} issueNumber Issue の番号
 * @returns {{ state: string, labelNames: string[] }} state（'OPEN' / 'CLOSED'）とラベル名
 * @throws {TechnicalError} gh が返した state かラベルを読めないとき
 * @throws {Error} gh が失敗したとき
 */
export function readIssueStatus(issueNumber) {
  const { state, labels } = runJson('gh', [
    'issue',
    'view',
    String(issueNumber),
    '--repo',
    config.repository,
    '--json',
    'state,labels'
  ])
  // state が欠けたまま渡すと「OPEN でない」と読まれ、閉じた・差分なしと取り違えた記録が残り、needs-human-check も付かない
  if ((state !== 'OPEN' && state !== 'CLOSED') || !Array.isArray(labels)) {
    throw new TechnicalError(
      `Issue #${issueNumber} の state かラベルを読めません: ${JSON.stringify({ state, labels })}`
    )
  }
  return { state, labelNames: labels.map(({ name }) => name) }
}

/**
 * Issue の sub-issue と、gh にログインしている自分のログイン名を引く。
 *
 * @param {number} issueNumber 親 Issue の番号
 * @returns {{ viewerLogin: string, subIssues: ReturnType<typeof toSubIssue>[] }} 自分のログイン名と sub-issue（state は 'OPEN' / 'CLOSED'）
 * @throws {TechnicalError} sub-issue が一度に読める件数を超えたとき
 * @throws {Error} gh が失敗したとき
 */
export function listSubIssues(issueNumber) {
  const [repositoryOwner, repositoryName] = config.repository.split('/')
  const {
    data: { repository, viewer }
  } = runJson('gh', [
    'api',
    'graphql',
    '-f',
    `query=${SUB_ISSUES_QUERY}`,
    '-f',
    `owner=${repositoryOwner}`,
    '-f',
    `name=${repositoryName}`,
    '-F',
    `number=${issueNumber}`,
    '-f',
    `statusFieldName=${config.board.statusFieldName}`
  ])
  const { totalCount, nodes } = repository.issue.subIssues
  if (totalCount > nodes.length) {
    throw new TechnicalError(
      `#${issueNumber} の sub-issue ${totalCount} 件のうち ${nodes.length} 件しか読めていません。読み落とした子を載せ損ねるため止めます`
    )
  }
  return { viewerLogin: viewer.login, subIssues: nodes.map(toSubIssue) }
}

/**
 * GraphQL が返した sub-issue のノードを、子を選ぶ純粋関数が受け取る形にする。
 *
 * @param {{ number: number, url: string, state: string, repository: { nameWithOwner: string }, assignees: { nodes: { login: string }[] }, labels: { nodes: { name: string }[] }, projectItems: { nodes: { project?: { number: number, owner: { login?: string } }, fieldValueByName?: { name?: string } | null }[] } }} node sub-issue のノード
 * @returns {{ number: number, url: string, state: string, repository: string, labelNames: string[], assigneeLogins: string[], boardStatusName: string | null }} 子（boardStatusName は config.mjs のボードに無ければ null）
 */
function toSubIssue({ number, url, state, repository, assignees, labels, projectItems }) {
  return {
    number,
    url,
    state,
    repository: repository.nameWithOwner,
    labelNames: labels.nodes.map((label) => label.name),
    assigneeLogins: assignees.nodes.map((assignee) => assignee.login),
    boardStatusName: findBoardStatusName(projectItems.nodes)
  }
}
