// 責務: GitHub Projects のボードの着手待ちから、いま着手できる Issue を着手順に選び出し、カードの Status を書き換える。
//   拾わせたい Issue を着手待ちに置くのもここが担う。Issue が載った project のうち、このボードのカードを見分けて Status を読むのもここが担う。
//
// 設計意図（WHY）:
// - フィールド ID・選択肢 ID を設定に持たせず、毎回表記から引き直す。ID は人間が見ても正しさを
//   確かめられず、選択肢を作り直すと黙って値が変わるため（Issue #480）。
// - どのカードを拾うかは AI に決めさせず、ここで決定論的に決める。同じ盤面なら必ず同じ Issue が
//   選ばれ、実行を追いかけられる状態を保つ。
// - 候補の絞り込み（Status・ラベル・担当者・open な Issue）は Projects の検索に任せる。全カードを取ると
//   Issue 本文ごと数MBを読むことになり、閉じた Issue が着手待ちに残っていても検索が弾いてくれる。
// - 候補は `gh` にログインしている自分が担当者の Issue に絞る。着手中へ動かすまでに準備で数分掛かり、
//   その間に別の台が同じ Issue を選ぶ取り合いを、担当者を先に決めておくことで起こさない（Issue #683）。
//   同じアカウントのプロセスどうしは、同じマシンなら Issue ごとのロック（index.mjs）で取り合わない。
//   別のマシンで同じアカウントを動かすと取り合う。
// - 表記の誤りは「候補0件」と区別がつかないので、着手待ちの表記も選択肢に実在するかを先に確かめる。
// - ブロッカーの state は毎回 gh で引き直す。候補の本文に書かれた (closed) の印は、人間が
//   `/issue-deps` を回した時点のものでしかない。引けなかったブロッカーは open と同じに扱う。
//   「完了」と取り違えると未完の依存先を待たずに着手し、全体を止めると無関係な候補まで止まる。

import { TechnicalError } from '../lib/errors.mjs'
import { config } from './config.mjs'
import { runJson, runOrThrow } from './shell.mjs'
import { extractBlockerIssueNumbers, selectStartableIssues } from './startOrder.mjs'
import { showWarning } from './ui.mjs'

const { board, repository, targetIssueLabel } = config

// JSON 出力を返す gh project サブコマンドに共通する引数
const ghProjectJsonArgs = [String(board.number), '--owner', board.owner, '--format', 'json']

// 着手待ちの候補として一度に読む枚数。超えていたら読み落としとして止める
const CANDIDATE_FETCH_LIMIT = 100

// gh project にはカード1枚の Status を引くサブコマンドが無いので、GraphQL で引く
const CARD_STATUS_QUERY = `query($itemId: ID!, $statusFieldName: String!) {
  node(id: $itemId) {
    ... on ProjectV2Item {
      fieldValueByName(name: $statusFieldName) { ... on ProjectV2ItemFieldSingleSelectValue { name } }
    }
  }
}`

// findBoardStatusName が読む項目の GraphQL の選択。Issue の projectItems のノードの中に埋め込む（`$statusFieldName` を宣言したクエリで使う）。
// 見分けに使う項目と見分ける処理を同じファイルに置き、片方だけ直して、どのカードにも一致しない（Status が null になる）事故を防ぐ
export const BOARD_CARD_STATUS_FIELDS = `project { number owner { ... on User { login } ... on Organization { login } } }
fieldValueByName(name: $statusFieldName) { ... on ProjectV2ItemFieldSingleSelectValue { name } }`

/**
 * いま着手できる Issue を、着手する順に並べて返す。
 *
 * 候補は「着手待ちの Status かつ対象ラベル付きの、自分が担当者の open な Issue」のうち対象リポジトリのもので、
 * そこから closed だと確かめられないブロッカーが残るもの・ブロッカー節を読めないものを外し、
 * 段番号昇順 → Issue 番号昇順に並べる。
 *
 * @returns {{ itemId: string, number: number, title: string, body?: string, labelNames: string[] }[]} 着手できる Issue（無ければ空配列）
 * @throws {TechnicalError} ボードの表記が config.mjs と食い違うとき・候補が一度に読める枚数を超えたとき
 * @throws {Error} gh が失敗したとき（shell.mjs が投げる）
 */
export function listStartableIssues() {
  resolveStatusOption(board.readyStatusName)

  const candidates = listReadyItems()
    .filter((readyItem) => readyItem.repository?.endsWith(`/${repository}`))
    .map((readyItem) => ({
      itemId: readyItem.id,
      number: readyItem.content.number,
      title: readyItem.content.title,
      body: readyItem.content.body,
      labelNames: readyItem.labels ?? []
    }))

  return selectStartableIssues(candidates, findUnresolvedBlockerNumbers(candidates))
}

/**
 * カード1枚の、いまの Status の表記を引く。listStartableIssues の一覧より新しい Status が要るときに使う。
 *
 * @param {string} itemId ボードのカード ID
 * @returns {string | null} Status の表記（Status が空なら null）
 * @throws {TechnicalError} カードが見つからないとき
 * @throws {Error} gh が失敗したとき（shell.mjs が投げる）
 */
export function readCardStatusName(itemId) {
  const {
    data: { node }
  } = runJson('gh', [
    'api',
    'graphql',
    '-f',
    `query=${CARD_STATUS_QUERY}`,
    '-f',
    `itemId=${itemId}`,
    '-f',
    `statusFieldName=${board.statusFieldName}`
  ])
  if (!node) throw new TechnicalError(`ボードにカード ${itemId} が見つかりません`)
  return node.fieldValueByName?.name ?? null
}

/**
 * Issue が載った project のカードから、config.mjs のボードのカードを見分け、その Status の表記を返す。
 *
 * project は number と owner の組で見分ける。同じ number の project は owner が違えば別物だからである。
 *
 * @param {{ project?: { number: number, owner: { login?: string } }, fieldValueByName?: { name?: string } | null }[]} projectItems Issue が載った project のカード（GraphQL の projectItems.nodes を BOARD_CARD_STATUS_FIELDS で引いたもの）
 * @returns {string | null} Status の表記（Issue がこのボードに載っていないとき・Status が空なら null）
 */
export function findBoardStatusName(projectItems) {
  const boardItem = projectItems.find(
    ({ project }) => project?.number === board.number && project.owner.login === board.owner
  )
  return boardItem?.fieldValueByName?.name ?? null
}

/**
 * Issue をこのツールが拾える形で着手待ちに置く。カードをボードに載せて Status を着手待ちへ動かし、担当者に自分を足す。
 *
 * 担当者を足さないと、着手待ちにあっても候補の検索（`assignee:@me`）に掛からず拾われない。
 *
 * @param {string} issueUrl Issue の URL
 * @returns {void}
 * @throws {TechnicalError} ボードの表記が config.mjs と食い違うとき・gh の出力に必要な ID が無いとき
 * @throws {Error} gh が失敗したとき（shell.mjs が投げる）
 */
export function putOnReadyAssignedToMe(issueUrl) {
  addCardWithStatus({ issueUrl, statusName: board.readyStatusName })
  runOrThrow('gh', ['issue', 'edit', issueUrl, '--add-assignee', '@me'])
}

/**
 * カードの Status を「着手中」を表す選択肢へ動かす。
 *
 * @param {string} itemId ボードのカード ID
 * @returns {void}
 * @throws {TechnicalError} ボードの表記が config.mjs と食い違うとき・gh の出力に必要な ID が無いとき
 * @throws {Error} gh が失敗したとき（shell.mjs が投げる）
 */
export function markCardAsStarted(itemId) {
  moveCardToStatus({ itemId, statusName: board.inProgressStatusName })
}

/**
 * Issue のカードをボードに載せ、Status を「着手中」を表す選択肢へ動かし、その表記を返す。
 *
 * Issue の URL しか持たない呼び出し元（`scripts/move-issue-card.mjs`）のための入口である。
 * 動かした先を返すので、呼び出し元は動かした先の表記を自分で持たなくてよい。
 *
 * @param {string} issueUrl Issue の URL
 * @returns {string} 動かした先の選択肢の表記
 * @throws {TechnicalError} ボードの表記が config.mjs と食い違うとき・gh の出力に必要な ID が無いとき
 * @throws {Error} gh が失敗したとき（shell.mjs が投げる）
 */
export function markIssueAsStarted(issueUrl) {
  addCardWithStatus({ issueUrl, statusName: board.inProgressStatusName })
  return board.inProgressStatusName
}

/**
 * Status フィールドと、その選択肢の ID を表記から引く。
 *
 * @param {string} optionName 選択肢の表記（config.mjs が持つ値）
 * @returns {{ fieldId: string, optionId: string }} フィールド ID と選択肢 ID
 * @throws {TechnicalError} 表記に一致するフィールド・選択肢がボードに無いとき
 */
function resolveStatusOption(optionName) {
  const { fields } = runJson('gh', ['project', 'field-list', ...ghProjectJsonArgs])
  const statusField = (fields ?? []).find((field) => field.name === board.statusFieldName)
  if (!statusField) {
    throw new TechnicalError(
      `ボードに「${board.statusFieldName}」フィールドがありません。config.mjs の statusFieldName を直してください`
    )
  }

  const option = (statusField.options ?? []).find((candidate) => candidate.name === optionName)
  if (!option) {
    throw new TechnicalError(
      `「${board.statusFieldName}」に「${optionName}」という選択肢がありません。config.mjs の表記を直してください`
    )
  }

  return { fieldId: statusField.id, optionId: option.id }
}

/**
 * 着手待ちで対象ラベル付きの、自分が担当者の open な Issue のカードを取得する。
 *
 * @returns {{ id: string, labels?: string[], repository?: string, content: { number: number, title: string, body?: string } }[]} カードの配列
 * @throws {TechnicalError} 候補が一度に読める枚数を超えたとき
 * @throws {Error} gh が失敗したとき（shell.mjs が投げる）
 */
function listReadyItems() {
  const query = `"${board.statusFieldName}":"${board.readyStatusName}" label:"${targetIssueLabel}" is:issue is:open assignee:@me`
  const { items = [], totalCount = 0 } = runJson('gh', [
    'project',
    'item-list',
    ...ghProjectJsonArgs,
    '--limit',
    String(CANDIDATE_FETCH_LIMIT),
    '--query',
    query
  ])
  if (totalCount > items.length) {
    throw new TechnicalError(
      `着手待ちの候補 ${totalCount} 件のうち ${items.length} 件しか読めていません。読み落とした中に先に着手すべき Issue があり得るため止めます`
    )
  }
  return items
}

/**
 * Issue の state を引く。引けなければ理由を出して null を返す。
 *
 * @param {number} issueNumber Issue 番号
 * @returns {string | null} state（'OPEN'・'CLOSED' など）。引けなければ null
 */
function readIssueState(issueNumber) {
  try {
    const { state } = runJson('gh', [
      'issue',
      'view',
      String(issueNumber),
      '--repo',
      repository,
      '--json',
      'state'
    ])
    return state ?? null
  } catch (error) {
    showWarning(`ブロッカー #${issueNumber} の state を引けませんでした: ${error.message}`)
    return null
  }
}

/**
 * 候補のブロッカーのうち、closed だと確かめられなかった Issue の番号を集める。
 *
 * @param {{ body?: string }[]} candidates 着手待ちの候補
 * @returns {Set<number>} closed だと確かめられなかったブロッカーの Issue 番号
 */
function findUnresolvedBlockerNumbers(candidates) {
  const blockerNumbers = new Set(
    candidates.flatMap((candidate) => extractBlockerIssueNumbers(candidate.body) ?? [])
  )
  const unresolvedBlockerNumbers = new Set()
  for (const blockerNumber of blockerNumbers) {
    if (readIssueState(blockerNumber) !== 'CLOSED') unresolvedBlockerNumbers.add(blockerNumber)
  }
  return unresolvedBlockerNumbers
}

/**
 * カードの Status を、表記で指定した選択肢へ動かす。
 *
 * @param {{ itemId: string, statusName: string }} params ボードのカード ID と、動かす先の選択肢の表記（config.mjs が持つ値）
 * @returns {void}
 * @throws {TechnicalError} ボードの表記が config.mjs と食い違うとき・gh の出力に必要な ID が無いとき
 * @throws {Error} gh が失敗したとき（shell.mjs が投げる）
 */
function moveCardToStatus({ itemId, statusName }) {
  const { id: projectId } = runJson('gh', ['project', 'view', ...ghProjectJsonArgs])
  if (!projectId) throw new TechnicalError('gh project view の出力に project の ID がありません')
  const { fieldId, optionId } = resolveStatusOption(statusName)

  runOrThrow('gh', [
    'project',
    'item-edit',
    '--id',
    itemId,
    '--project-id',
    projectId,
    '--field-id',
    fieldId,
    '--single-select-option-id',
    optionId
  ])
}

/**
 * Issue のカードをボードに載せ、カード ID を返す。既に載っていれば、そのカードの ID を返す。
 *
 * @param {string} issueUrl Issue の URL
 * @returns {string} ボードのカード ID
 * @throws {TechnicalError} gh の出力にカードの ID が無いとき
 * @throws {Error} gh が失敗したとき（shell.mjs が投げる）
 */
function addCard(issueUrl) {
  const { id: itemId } = runJson('gh', [
    'project',
    'item-add',
    ...ghProjectJsonArgs,
    '--url',
    issueUrl
  ])
  if (!itemId) throw new TechnicalError('gh project item-add の出力にカードの ID がありません')
  return itemId
}

/**
 * Issue のカードをボードに載せ、Status を表記で指定した選択肢へ動かす。
 *
 * @param {{ issueUrl: string, statusName: string }} params Issue の URL と、動かす先の選択肢の表記（config.mjs が持つ値）
 * @returns {void}
 * @throws {TechnicalError} ボードの表記が config.mjs と食い違うとき・gh の出力に必要な ID が無いとき
 * @throws {Error} gh が失敗したとき（shell.mjs が投げる）
 */
function addCardWithStatus({ issueUrl, statusName }) {
  // 表記が食い違うボードに「Status の無いカード」を増やさないため、載せる前に選択肢の実在を確かめる
  resolveStatusOption(statusName)
  // 載せた直後の書き換えが、組み込みワークフロー（載せたカードの Status を決める自動化）に上書きされないことは
  // 確かめていない
  moveCardToStatus({ itemId: addCard(issueUrl), statusName })
}
