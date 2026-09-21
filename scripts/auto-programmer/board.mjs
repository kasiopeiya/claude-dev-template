// 責務: GitHub Projects のボードの着手待ちから、いま着手できる Issue を着手順に選び出し、選んだカードの Status を書き換える。
//
// 設計意図（WHY）:
// - フィールド ID・選択肢 ID を設定に持たせず、毎回表記から引き直す。ID は人間が見ても正しさを
//   確かめられず、選択肢を作り直すと黙って値が変わるため（Issue #480）。
// - どのカードを拾うかは AI に決めさせず、ここで決定論的に決める。同じ盤面なら必ず同じ Issue が
//   選ばれ、実行を追いかけられる状態を保つ。
// - 候補の絞り込み（Status・ラベル・open な Issue）は Projects の検索に任せる。全カードを取ると
//   Issue 本文ごと数MBを読むことになり、閉じた Issue が着手待ちに残っていても検索が弾いてくれる。
// - 表記の誤りは「候補0件」と区別がつかないので、着手待ちの表記も選択肢に実在するかを先に確かめる。
// - ブロッカーの state は毎回 gh で引き直す。候補の本文に書かれた (closed) の印は、人間が
//   `/issue-deps` を回した時点のものでしかない。引けなかったブロッカーは open と同じに扱う。
//   「完了」と取り違えると未完の依存先を待たずに着手し、全体を止めると無関係な候補まで止まる。

import { config } from './config.mjs'
import { runJson, runOrThrow } from './shell.mjs'
import { extractBlockerIssueNumbers, selectStartableIssues } from './startOrder.mjs'

const { board, repository, targetIssueLabel } = config

// JSON 出力を返す gh project サブコマンドに共通する引数
const ghProjectJsonArgs = [String(board.number), '--owner', board.owner, '--format', 'json']

// 着手待ちの候補として一度に読む枚数。超えていたら読み落としとして止める
const CANDIDATE_FETCH_LIMIT = 100

/**
 * Status フィールドと、その選択肢の ID を表記から引く。
 *
 * @param {string} optionName 選択肢の表記（config.mjs が持つ値）
 * @returns {{ fieldId: string, optionId: string }} フィールド ID と選択肢 ID
 * @throws {Error} 表記に一致するフィールド・選択肢がボードに無いとき
 */
function resolveStatusOption(optionName) {
  const { fields } = runJson('gh', ['project', 'field-list', ...ghProjectJsonArgs])
  const statusField = (fields ?? []).find((field) => field.name === board.statusFieldName)
  if (!statusField) {
    throw new Error(
      `ボードに「${board.statusFieldName}」フィールドがありません。config.mjs の statusFieldName を直してください`
    )
  }

  const option = (statusField.options ?? []).find((candidate) => candidate.name === optionName)
  if (!option) {
    throw new Error(
      `「${board.statusFieldName}」に「${optionName}」という選択肢がありません。config.mjs の表記を直してください`
    )
  }

  return { fieldId: statusField.id, optionId: option.id }
}

/**
 * 着手待ちで対象ラベル付きの、open な Issue のカードを取得する。
 *
 * @returns {{ id: string, labels?: string[], repository?: string, content: { number: number, title: string, body?: string } }[]} カードの配列
 * @throws {Error} gh が失敗したとき・候補が一度に読める枚数を超えたとき
 */
function listReadyItems() {
  const query = `"${board.statusFieldName}":"${board.readyStatusName}" label:"${targetIssueLabel}" is:issue is:open`
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
    throw new Error(
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
    console.error(`ブロッカー #${issueNumber} の state を引けませんでした: ${error.message}`)
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
 * いま着手できる Issue を、着手する順に並べて返す。
 *
 * 候補は「着手待ちの Status かつ対象ラベル付きの open な Issue」のうち対象リポジトリのもので、
 * そこから closed だと確かめられないブロッカーが残るもの・ブロッカー節を読めないものを外し、
 * 段番号昇順 → Issue 番号昇順に並べる。
 *
 * @returns {{ itemId: string, number: number, title: string, body?: string, labelNames: string[] }[]} 着手できる Issue（無ければ空配列）
 * @throws {Error} ボードの表記が config.mjs と食い違うとき・gh が失敗したとき
 */
export function listStartableIssues() {
  resolveStatusOption(board.readyStatusName)

  const candidates = listReadyItems()
    .filter((item) => item.repository?.endsWith(`/${repository}`))
    .map((item) => ({
      itemId: item.id,
      number: item.content.number,
      title: item.content.title,
      body: item.content.body,
      labelNames: item.labels ?? []
    }))

  return selectStartableIssues(candidates, findUnresolvedBlockerNumbers(candidates))
}

/**
 * カードの Status を「着手中」を表す選択肢へ動かす。
 *
 * @param {string} itemId ボードのカード ID
 * @returns {void}
 * @throws {Error} ボードの表記が config.mjs と食い違うとき・gh が失敗したとき
 */
export function markAsStarted(itemId) {
  const { id: projectId } = runJson('gh', ['project', 'view', ...ghProjectJsonArgs])
  if (!projectId) throw new Error('gh project view の出力に project の ID がありません')
  const { fieldId, optionId } = resolveStatusOption(board.inProgressStatusName)

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
