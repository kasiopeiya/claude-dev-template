#!/usr/bin/env node
// 責務: 要件定義書のうち「照合すれば一意に決まる」欠陥だけを機械が判定し、AI レビューの前段で落とす。
//   ID 参照の整合性は答えが一意に決まる事実であり、AI の推論に委ねるとレビューのたびに判定がぶれる（Issue #266）。
//
// なぜ列名をハードコードするか:
//   Markdown の表をパースするには列名が要るため、requirements-doc-policy.md が定める列名をここへ写している。
//   ポリシーが列名を変えると表のパースが外れ、参照が0件になって「違反0件」として静かに通ってしまう。
//   そこで、想定した表・列が見つからないこと自体を違反として落とす（列定義ガード）。
//   このガードが無いと、検査はポリシーが動いた瞬間から無言で腐る。検査を足すときはガードも必ず併せて足すこと。

import { existsSync, readFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const DEFAULT_TARGET_PATH = 'docs/requirements.md'

// 非機能要件の分類の正典はカタログ側にある。分類名は受入基準の `検証対象` に書ける値なので、ここから引く
const NON_FUNCTIONAL_CATALOG_PATH = 'docs/reference/non-functional-requirement-items.md'
const CATALOG_CLASSIFICATION_PATTERN = /^## ([A-F])\.\s*(.+?)\s*$/gm

/** このスクリプトが判定した観点名。AI レビューはこれらを担当から外す */
const ASPECTS = ['表と列の定義（列定義ガード）', 'トレーサビリティ（ID 参照整合性）']

const [ASPECT_TABLE_DEFINITION, ASPECT_ID_REFERENCE] = ASPECTS

/**
 * 検査に使う表と、その表に必要な列。列名の正典は requirements-doc-policy.md の各節。
 * ここに挙げた表・列のいずれかが見つからなければ、検査そのものが成立しないので違反として落とす。
 */
const TABLE_SPECS = [
  {
    key: 'io',
    heading: '入出力情報一覧',
    columns: [
      'ID',
      '情報名',
      '入出力区分',
      '送り手',
      '受け手',
      '内容',
      '取扱量',
      '頻度',
      '利用目的',
      '利用業務',
      '出所'
    ]
  },
  {
    key: 'businessRule',
    heading: 'ビジネスルール一覧',
    columns: ['ID', 'ルール名', 'ルール内容', 'タイプ', '関連ルール', '出所']
  },
  {
    key: 'functionSpec',
    heading: '機能仕様',
    columns: [
      '機能ID',
      'アクター',
      'トリガー',
      '入力',
      '適用ルール',
      '出力',
      '事後条件',
      '主要な例外'
    ]
  },
  {
    key: 'businessTask',
    heading: '業務一覧',
    columns: ['概要', 'システム化区分', '関連ビジネスルールID']
  },
  {
    key: 'acceptance',
    heading: '受入基準',
    columns: ['検証対象']
  }
]

/** ID を列挙する列 → 参照先の表と列。書けるのは参照先に実在する ID だけ（policy「相互参照」） */
const ID_REFERENCES = [
  { from: 'functionSpec', column: '入力', to: 'io', toColumn: 'ID' },
  { from: 'functionSpec', column: '出力', to: 'io', toColumn: 'ID' },
  { from: 'functionSpec', column: '適用ルール', to: 'businessRule', toColumn: 'ID' },
  { from: 'businessTask', column: '関連ビジネスルールID', to: 'businessRule', toColumn: 'ID' }
]

// 「参照が無い」ことを明示したセル。書き忘れの空セルとは区別する（policy「空欄にすると書き忘れと区別できない」）
const NO_REFERENCE_TOKENS = new Set(['—', '–', '-', 'ー', 'なし', '該当なし', 'N/A', 'n/a'])

/**
 * セル・見出しの装飾を落として比較できる形にする。
 *
 * @param {string} text 生の文字列
 * @returns {string} 比較用に正規化した文字列
 */
function normalizeCell(text) {
  return text.replace(/[`*]/g, '').trim()
}

/**
 * 丸括弧の補足を落とす。列名・見出しの表記ゆれ（`ルール内容（具体値まで）`）を吸収する。
 *
 * @param {string} text 正規化済みの文字列
 * @returns {string} 補足を除いた文字列
 */
function stripParenthetical(text) {
  return text.replace(/[（(][^）)]*[）)]/g, '').trim()
}

/**
 * 表の1行をセルへ分解する。
 *
 * @param {string} line 1行分の本文
 * @returns {string[]} セルの配列
 */
function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

/**
 * Markdown 表の区切り行（`|---|---|`）かを判定する。
 *
 * @param {string} line 1行分の本文
 * @returns {boolean} 区切り行なら true
 */
function isDelimiterRow(line) {
  if (!line.includes('-') || !line.includes('|')) return false
  const cells = splitRow(line)
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell))
}

/**
 * ヘッダ行から表を1つ読み取る。
 *
 * @param {string[]} lines 全行
 * @param {number} headerIndex ヘッダ行の 0 始まり位置
 * @returns {{ headers: string[], rows: { cells: string[], line: number }[], line: number, endIndex: number }} 表
 */
function readTable(lines, headerIndex) {
  const headers = splitRow(lines[headerIndex]).map(normalizeCell)
  const rows = []
  let cursor = headerIndex + 2

  while (cursor < lines.length && lines[cursor].includes('|') && lines[cursor].trim() !== '') {
    rows.push({ cells: splitRow(lines[cursor]).map(normalizeCell), line: cursor + 1 })
    cursor++
  }

  return { headers, rows, line: headerIndex + 1, endIndex: cursor }
}

/**
 * Markdown を見出しと表へ分解する。コードフェンス内は対象外（Mermaid の `|` を表と誤認しないため）。
 *
 * @param {string} source ファイル全文
 * @returns {{ lines: string[], headings: { level: number, text: string, line: number }[], tables: object[] }} 解析結果
 */
function parseMarkdown(source) {
  const lines = source.split('\n')
  const headings = []
  const tables = []
  let insideFence = false

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]

    if (/^\s*(```|~~~)/.test(line)) {
      insideFence = !insideFence
      continue
    }
    if (insideFence) continue

    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
    if (heading) {
      headings.push({ level: heading[1].length, text: normalizeCell(heading[2]), line: index + 1 })
      continue
    }

    if (line.includes('|') && isDelimiterRow(lines[index + 1] ?? '')) {
      const table = readTable(lines, index)
      tables.push(table)
      index = table.endIndex - 1
    }
  }

  return { lines, headings, tables }
}

/**
 * 見出しを名前で引く。完全一致 → 前方一致 → 部分一致の順に探す。
 * 部分一致を後回しにするのは、`移行の受入基準` が `受入基準` を横取りしないようにするため。
 *
 * @param {{ level: number, text: string, line: number }[]} headings 全見出し
 * @param {string} name 探す見出し名
 * @returns {{ level: number, text: string, line: number } | undefined} 見つかった見出し
 */
function findHeading(headings, name) {
  return (
    headings.find((heading) => stripParenthetical(heading.text) === name) ??
    headings.find((heading) => heading.text.startsWith(name)) ??
    headings.find((heading) => heading.text.includes(name))
  )
}

/**
 * 見出しが支配する行の範囲を返す（次の同レベル以上の見出しまで）。
 *
 * @param {object} doc parseMarkdown の結果
 * @param {{ level: number, line: number }} heading 対象の見出し
 * @returns {{ start: number, end: number }} 1 始まりの行範囲
 */
function sectionRange(doc, heading) {
  const next = doc.headings.find(
    (other) => other.line > heading.line && other.level <= heading.level
  )
  return { start: heading.line, end: next ? next.line - 1 : doc.lines.length }
}

/**
 * 列名から列位置を引く。
 *
 * @param {object} table 表
 * @param {string} name 列名
 * @returns {number} 見つからなければ -1
 */
function columnIndex(table, name) {
  return table.headers.findIndex((header) => header === name || stripParenthetical(header) === name)
}

/**
 * 列の値をすべて取り出す。
 *
 * @param {object} table 表
 * @param {string} name 列名
 * @returns {{ value: string, line: number }[]} セルの値と行番号
 */
function columnCells(table, name) {
  const index = columnIndex(table, name)
  if (index === -1) return []
  return table.rows.map((row) => ({ value: row.cells[index] ?? '', line: row.line }))
}

/**
 * 表定義（表の存在・列の存在）を検査し、以降の検査で使う表を返す。
 *
 * @param {object} doc parseMarkdown の結果
 * @returns {{ tables: Record<string, object>, violations: object[] }} 見つかった表と違反
 */
function checkTableDefinitions(doc) {
  const tables = {}
  const violations = []
  const headingList = doc.headings.map((heading) => heading.text).join(' / ')

  for (const spec of TABLE_SPECS) {
    const heading = findHeading(doc.headings, spec.heading)
    if (!heading) {
      violations.push({
        aspect: ASPECT_TABLE_DEFINITION,
        line: 1,
        message: `「${spec.heading}」の見出しが無い。この表を前提とした検査が成立しない`,
        quote: `見出し一覧: ${headingList}`
      })
      continue
    }

    const range = sectionRange(doc, heading)
    const inSection = doc.tables.filter(
      (table) => table.line > range.start && table.line <= range.end
    )
    if (inSection.length === 0) {
      violations.push({
        aspect: ASPECT_TABLE_DEFINITION,
        line: heading.line,
        message: `「${spec.heading}」に表が無い。箇条書きで書くと ID 参照の検査が素通りする`,
        quote: doc.lines[heading.line - 1]
      })
      continue
    }

    const matched = inSection.find((table) =>
      spec.columns.every((column) => columnIndex(table, column) !== -1)
    )
    if (matched) {
      tables[spec.key] = matched
      continue
    }

    const closest = inSection.reduce((best, table) =>
      countPresentColumns(table, spec) > countPresentColumns(best, spec) ? table : best
    )
    const missing = spec.columns.filter((column) => columnIndex(closest, column) === -1)
    violations.push({
      aspect: ASPECT_TABLE_DEFINITION,
      line: closest.line,
      message: `「${spec.heading}」に想定した列が無い（不足: ${missing.join('・')}）`,
      quote: doc.lines[closest.line - 1]
    })
  }

  return { tables, violations }
}

/**
 * 表が仕様の列をいくつ持つかを数える。
 *
 * @param {object} table 表
 * @param {{ columns: string[] }} spec 表の仕様
 * @returns {number} 揃っている列数
 */
function countPresentColumns(table, spec) {
  return spec.columns.filter((column) => columnIndex(table, column) !== -1).length
}

/**
 * ID を列挙したセルを参照トークンへ分解する。
 * 括弧の補足（`IO-01（会員情報）`）を落とすので、ID の書式を決め打ちせずに済む。
 *
 * @param {string} cell セルの値
 * @returns {string[]} 参照トークン
 */
function referenceTokens(cell) {
  return normalizeCell(cell)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/[（(][^）)]*[）)]/g, ' ')
    .split(/[、,／/・\s]+/)
    .map((token) => token.trim())
    .filter((token) => token !== '' && !NO_REFERENCE_TOKENS.has(token))
}

/**
 * ID 参照整合性を検査する。参照先の `ID` 列に実在しない値を落とす。
 *
 * @param {Record<string, object>} tables checkTableDefinitions が返した表
 * @param {object} doc parseMarkdown の結果
 * @returns {object[]} 違反
 */
function checkIdReferences(tables, doc) {
  const violations = []

  for (const reference of ID_REFERENCES) {
    const source = tables[reference.from]
    const target = tables[reference.to]
    if (!source || !target) continue

    const validIds = new Set(columnCells(target, reference.toColumn).map((cell) => cell.value))
    for (const cell of columnCells(source, reference.column)) {
      for (const token of referenceTokens(cell.value)) {
        if (validIds.has(token)) continue
        violations.push({
          aspect: ASPECT_ID_REFERENCE,
          line: cell.line,
          message: `${reference.column} の「${token}」は ${reference.to === 'io' ? '入出力情報一覧' : 'ビジネスルール一覧'}の ${reference.toColumn} 列に実在しない`,
          quote: doc.lines[cell.line - 1]
        })
      }
    }
  }

  return violations
}

/**
 * 受入基準の `検証対象` に書ける値を集める。
 * 許容値は機能ID・業務名・SLO・非機能の分類名（policy「受入基準」）。
 *
 * @param {Record<string, object>} tables checkTableDefinitions が返した表
 * @param {{ symbol: string, name: string }[]} classifications 非機能要件の分類
 * @returns {string[]} 許容値
 */
function acceptanceTargetValues(tables, classifications) {
  const values = ['SLO']

  if (tables.functionSpec) {
    values.push(...columnCells(tables.functionSpec, '機能ID').map((cell) => cell.value))
  }

  if (tables.businessTask) {
    // 業務名を持つ列は policy が名前を固定していない（大分類／中分類／小分類で識別する）。
    // 分類列があればそれを、無ければ表の全セルを許容値に取る（見逃す側に倒し、偽陽性を出さない）
    const nameColumns = tables.businessTask.headers.filter((header) => header.includes('分類'))
    const cells = nameColumns.length
      ? nameColumns.flatMap((header) =>
          columnCells(tables.businessTask, header).map((cell) => cell.value)
        )
      : tables.businessTask.rows.flatMap((row) => row.cells)
    values.push(...cells)
  }

  for (const classification of classifications) {
    values.push(classification.name, `${classification.symbol}. ${classification.name}`)
  }

  return values.map(normalizeCell).filter((value) => value.length >= 2)
}

/**
 * 受入基準の `検証対象` が許容値へ解決できるかを検査する。
 *
 * @param {Record<string, object>} tables checkTableDefinitions が返した表
 * @param {object} doc parseMarkdown の結果
 * @param {{ symbol: string, name: string }[]} classifications 非機能要件の分類
 * @returns {object[]} 違反
 */
function checkAcceptanceTargets(tables, doc, classifications) {
  if (!tables.acceptance) return []

  const allowed = acceptanceTargetValues(tables, classifications)
  return columnCells(tables.acceptance, '検証対象')
    .filter((cell) => cell.value !== '' && !allowed.some((value) => cell.value.includes(value)))
    .map((cell) => ({
      aspect: ASPECT_ID_REFERENCE,
      line: cell.line,
      message: `検証対象の「${cell.value}」が、機能ID・業務名・SLO・非機能の分類名のいずれにも解決できない`,
      quote: doc.lines[cell.line - 1]
    }))
}

/**
 * 非機能要件の分類をカタログから抽出する。
 *
 * @param {string} catalogSource カタログの全文
 * @returns {{ symbol: string, name: string }[]} 分類
 */
function parseClassifications(catalogSource) {
  return [...catalogSource.matchAll(CATALOG_CLASSIFICATION_PATTERN)].map((match) => ({
    symbol: match[1],
    name: match[2]
  }))
}

/**
 * 要件定義書1本を検査する。副作用を持たないので、あとからテストを足せる。
 *
 * @param {{ source: string, catalogSource: string | null }} input 対象の全文と非機能カタログの全文
 * @returns {{ aspect: string, line: number, message: string, quote: string }[]} 違反
 */
export function findViolations({ source, catalogSource }) {
  const doc = parseMarkdown(source)
  const { tables, violations } = checkTableDefinitions(doc)
  const classifications = catalogSource ? parseClassifications(catalogSource) : []

  if (classifications.length === 0) {
    violations.push({
      aspect: ASPECT_TABLE_DEFINITION,
      line: 1,
      message: `${NON_FUNCTIONAL_CATALOG_PATH} から非機能要件の分類を抽出できない。受入基準の検証対象を判定できない`,
      quote:
        catalogSource === null ? 'カタログが読めない' : 'カタログに `## A. 〜` 形式の見出しが無い'
    })
  }

  violations.push(...checkIdReferences(tables, doc))
  violations.push(...checkAcceptanceTargets(tables, doc, classifications))

  return violations.sort((left, right) => left.line - right.line)
}

/** 判定した観点名を出力する。AI レビューはこの一覧を担当から外す */
function printAspects() {
  console.log(`\nこのスクリプトが判定した観点:`)
  for (const aspect of ASPECTS) {
    console.log(`  - ${aspect}`)
  }
}

function main() {
  const targetPath =
    process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? DEFAULT_TARGET_PATH
  const absolutePath = resolve(process.cwd(), targetPath)

  if (!existsSync(absolutePath)) {
    console.log(`検査対象なし: ${targetPath} が存在しません。`)
    printAspects()
    return
  }

  const catalogPath = join(repoRoot, NON_FUNCTIONAL_CATALOG_PATH)
  const catalogSource = existsSync(catalogPath) ? readFileSync(catalogPath, 'utf8') : null
  const violations = findViolations({ source: readFileSync(absolutePath, 'utf8'), catalogSource })

  if (violations.length === 0) {
    console.log(`${targetPath} は機械判定した観点をすべて満たしています。`)
    printAspects()
    return
  }

  console.error(`${targetPath} に機械判定できる違反が ${violations.length} 件あります。`)
  for (const violation of violations) {
    console.error(`\n  ${targetPath}:${violation.line} [${violation.aspect}]`)
    console.error(`    ${violation.message}`)
    console.error(`    原文: ${violation.quote.trim()}`)
  }
  printAspects()
  process.exit(1)
}

main()
