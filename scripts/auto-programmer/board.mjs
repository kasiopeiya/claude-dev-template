// 責務: GitHub Projects のボードから「次に着手する Issue」を選び、その Status を書き換える。
//
// 設計意図（WHY）:
// - フィールド ID・選択肢 ID を設定に持たせず、毎回表記から引き直す。ID は人間が見ても正しさを
//   確かめられず、選択肢を作り直すと黙って値が変わるため（Issue #480）。
// - どのカードを拾うかは AI に決めさせず、ここで決定論的に決める。同じ盤面なら必ず同じ Issue が
//   選ばれ、実行を追いかけられる状態を保つ。
// - 候補の絞り込み（Status・ラベル・open な Issue）は Projects の検索に任せる。全カードを取ると
//   Issue 本文ごと数MBを読むことになり、閉じた Issue が着手待ちに残っていても検索が弾いてくれる。
// - 表記の誤りは「候補0件」と区別がつかないので、着手待ちの表記も選択肢に実在するかを先に確かめる。

import { config } from './config.mjs'
import { runJson, runOrThrow } from './shell.mjs'

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
 * @returns {{ id: string, labels?: string[], repository?: string, content: { number: number, title: string } }[]} カードの配列
 * @throws {Error} gh が失敗したとき・候補が一度に読める枚数を超えたとき
 */
function listStartableItems() {
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
      `着手待ちの候補 ${totalCount} 件のうち ${items.length} 件しか読めていません。番号の小さい Issue を読み落とすため止めます`
    )
  }
  return items
}

/**
 * 次に着手する Issue を1件選ぶ。候補が無ければ null を返す。
 *
 * 候補は「着手待ちの Status かつ対象ラベル付きの open な Issue」のうち対象リポジトリのもので、
 * Issue 番号の昇順に並べた先頭を返す。
 *
 * @returns {{ itemId: string, number: number, title: string, labelNames: string[] } | null} 選んだ Issue
 * @throws {Error} ボードの表記が config.mjs と食い違うとき・gh が失敗したとき
 */
export function findNextStartableIssue() {
  resolveStatusOption(board.readyStatusName)

  const nextIssue = listStartableItems()
    .filter((item) => item.repository?.endsWith(`/${repository}`))
    .sort((a, b) => a.content.number - b.content.number)[0]
  if (!nextIssue) return null

  return {
    itemId: nextIssue.id,
    number: nextIssue.content.number,
    title: nextIssue.content.title,
    labelNames: nextIssue.labels ?? []
  }
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
