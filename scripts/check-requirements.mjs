#!/usr/bin/env node
// 責務: 要件定義書のうち「照合すれば一意に決まる」欠陥だけを機械が判定し、AI レビューの前段で落とす。
//   ID 参照・必須項目の有無・列の有無などは答えが一意に決まる事実であり、
//   AI の推論に委ねるとレビューのたびに判定がぶれる（Issue #266・#267）。
//
// なぜ列名をハードコードするか:
//   Markdown の表をパースするには列名が要るため、requirements-doc-policy.md が定める列名をここへ写している。
//   ポリシーが列名を変えると表のパースが外れ、参照が0件になって「違反0件」として静かに通ってしまう。
//   そこで、想定した表・列が見つからないこと自体を違反として落とす（列定義ガード）。
//   このガードが無いと、検査はポリシーが動いた瞬間から無言で腐る。検査を足すときはガードも必ず併せて足すこと。
//
// 一覧そのものは転記しない:
//   必須／条件付き項目の一覧は requirements-doc-policy.md の「項目一覧」から、
//   非機能要件の分類は non-functional-requirement-items.md の見出しから、実行時に抽出する。
//   抽出できなければ判定できないので、それも違反として落とす。
//
// 属性突合だけは違反にせず警告にする（Issue #268）:
//   入出力情報一覧の `内容` 列にあってビジネスルール一覧に一度も現れない属性名は、警告として出すだけで
//   exit code を変えない。ルールの不在は読んでも目に入らないので探索は機械の仕事だが、
//   `内容` 列からの属性名の切り出しは自然文のパースで、ID 参照のように一意には決まらない。
//   機械が違反として落とすと偽陽性で執筆が止まるため、探索は機械・判定は AI と役割を分ける。
//   同じ理由で ASPECTS には載せない——載せると AI レビューが担当から外し、誰も判定しなくなる。
//   区切り文字などの切り出し規則は contentAttributes に書いてある。

import { existsSync, readFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const DEFAULT_TARGET_PATH = 'docs/requirements.md'
const POLICY_PATH = 'docs/policy/requirements-doc-policy.md'
const NON_FUNCTIONAL_CATALOG_PATH = 'docs/reference/non-functional-requirement-items.md'

// カタログの分類見出し（`## A. 可用性`）。記号は IPA 非機能要求グレードの大項目 ID なので増減しない
const CATALOG_CLASSIFICATION_PATTERN = /^## ([A-F])\.\s*(.+?)\s*$/gm

/** このスクリプトが判定した観点名。AI レビューはこれらを担当から外す */
const ASPECTS = {
  tableDefinition: '表と列の定義（列定義ガード）',
  idReference: 'トレーサビリティ（ID 参照整合性）',
  requiredItems: '必須項目・条件付き項目の存在',
  nonFunctional: '非機能要件の網羅（分類の節）',
  emptyCell: '空セル・優先度の理由',
  acceptanceCoverage: '受入基準（Must・Should のカバレッジ）',
  requiredDiagram: '機能要件の可視化（必須図と凡例）',
  format: '書式（金額・工数／解消期限／取扱量・頻度／ルールのタイプ）'
}

/**
 * 検査に使う表と、その表に必要な列。列名の正典は requirements-doc-policy.md の各節。
 * `allowNoneDeclaration` は「該当なし」と明記して表を置かないことをポリシーが許す節。
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
    key: 'functionList',
    heading: 'システム化機能一覧',
    // 優先度は受入基準のカバレッジを差集合で判定するために要る（policy「優先順位」は列に持たせることを許す）
    columns: ['機能ID', '優先度']
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
  },
  {
    key: 'constraint',
    heading: '制約と前提',
    columns: ['制約内容', '判定', '判定理由'],
    allowNoneDeclaration: true
  },
  {
    key: 'nonGoal',
    heading: 'スコープ外',
    columns: ['項目', '除外理由', '区分', '出所'],
    allowNoneDeclaration: true
  },
  {
    key: 'openQuestion',
    heading: 'オープンクエスチョン',
    columns: ['解決の相手', '解消期限'],
    allowNoneDeclaration: true
  },
  {
    key: 'slo',
    heading: 'SLO',
    columns: ['対象SLI', '目標値', '評価期間', 'ウィンドウ型'],
    allowNoneDeclaration: true
  }
]

/** ID を列挙する列 → 参照先の表と列。書けるのは参照先に実在する ID だけ（policy「相互参照」） */
const ID_REFERENCES = [
  { from: 'functionSpec', column: '入力', to: 'io', toLabel: '入出力情報一覧' },
  { from: 'functionSpec', column: '出力', to: 'io', toLabel: '入出力情報一覧' },
  { from: 'functionSpec', column: '適用ルール', to: 'businessRule', toLabel: 'ビジネスルール一覧' },
  {
    from: 'businessTask',
    column: '関連ビジネスルールID',
    to: 'businessRule',
    toLabel: 'ビジネスルール一覧'
  }
]

// 「参照が無い」ことを明示したセル。書き忘れの空セルとは区別する（policy「空欄にすると書き忘れと区別できない」）
const NO_REFERENCE_TOKENS = new Set(['—', '–', '-', 'ー', 'なし', '該当なし', 'N/A', 'n/a'])

// 属性名として拾わない語。列挙の締めくくりであって、ルールを引く対象にならない
const NON_ATTRIBUTE_TOKENS = new Set(['等', 'など', 'ほか', '他', 'その他', '一式', '各種'])

// 空欄を許さない列。policy が「無いと書き忘れと区別できない」と名指しするもの
const NON_EMPTY_COLUMNS = ['出所', '送り手', '受け手', '解決の相手', '解消期限', '検証対象']

// 受入基準がカバーしなければならない優先度。policy「優先順位」が挙げる2つの語彙のどちらでも読む
const COVERED_PRIORITY_PATTERN = /Must|Should|^(高|中)/i

// ビジネスルールのタイプ。policy「ビジネスルール一覧」がこの2つに限っている
const BUSINESS_RULE_TYPES = ['行動', '定義づけ']

// 解消期限は工程で書く（policy「オープンクエスチョン」）。日付・暦の表現が出たら違反
const DEADLINE_DATE_PATTERN = /\d{4}\s*年|\d{1,2}\s*月|月末|月内|四半期|Q[1-4]|\d{1,2}\/\d{1,2}/

// 取扱量・頻度は数値で書く。数値で書けないのは発生が事象に従属して読めないときだけで、
// そのときは発生契機を書く（policy「入出力情報一覧」）。下の語はその言い回しを拾う逃げ道で、正典はポリシー側
const OCCASION_PATTERN = /随時|都度|常時|不定期|異常時|障害時|任意操作|イベント/

/** 設計前に確定できない見積もり（policy「変動リスクのある実現コスト・技術予測は書かない」） */
const ESTIMATE_PATTERNS = [
  {
    // 金額は業務ルール（「100円ごとに1ポイント」）として正当に現れるので、費用の文脈と同時に出る行だけ落とす
    pattern:
      /^(?=.*(?:費用|コスト|見積|予算|月額|初期費|ランニング))(?=.*[0-9０-９][0-9０-９,，.]*\s*(?:円|万円|億円|ドル|USD))/,
    message: '設計前に確定できない金額（実現コスト）が書かれている'
  },
  {
    pattern: /[0-9０-９][0-9０-９,，.]*\s*人[日月]/,
    message: '工数（人日・人月）が書かれている'
  }
]

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
 * @returns {object} 表（ヘッダ・行・行番号・表の終端）
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
 * @returns {object} lines（全行）・textLines（フェンス外の行）・headings・tables
 */
function parseMarkdown(source) {
  const lines = source.split('\n')
  const headings = []
  const tables = []
  const textLines = []
  let insideFence = false

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]

    if (/^\s*(```|~~~)/.test(line)) {
      insideFence = !insideFence
      continue
    }
    if (insideFence) continue
    textLines.push({ text: line, line: index + 1 })

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

  return { lines, textLines, headings, tables }
}

/**
 * 見出しを名前で引く。完全一致 → 前方一致 → 部分一致の順に探す。
 * 部分一致を後回しにするのは、`移行の受入基準` が `受入基準` を横取りしないようにするため。
 *
 * @param {object[]} headings 全見出し
 * @param {string} name 探す見出し名
 * @returns {object | undefined} 見つかった見出し
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
 * @param {object} heading 対象の見出し
 * @returns {{ start: number, end: number }} 1 始まりの行範囲
 */
function sectionRange(doc, heading) {
  const next = doc.headings.find(
    (other) => other.line > heading.line && other.level <= heading.level
  )
  return { start: heading.line, end: next ? next.line - 1 : doc.lines.length }
}

/**
 * 節の本文（見出し行を除く）を返す。
 *
 * @param {object} doc parseMarkdown の結果
 * @param {object} heading 対象の見出し
 * @returns {string[]} 本文の行
 */
function sectionBody(doc, heading) {
  const range = sectionRange(doc, heading)
  return doc.lines.slice(range.start, range.end)
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
 * 違反を1件組み立てる。
 *
 * @param {object} doc parseMarkdown の結果
 * @param {{ aspect: string, line: number, message: string }} violation 観点・行・内容
 * @returns {object} 原文つきの違反
 */
function violationAt(doc, { aspect, line, message }) {
  return { aspect, line, message, quote: (doc.lines[line - 1] ?? '').trim() }
}

/**
 * 「文書のどこにも無い」ことを指す違反を組み立てる。
 * 見出しが1つも無い欠落は引用できる行を持たないので、確認した範囲（見出しの件数）を代わりに示す。
 *
 * @param {object} doc parseMarkdown の結果
 * @param {{ aspect: string, message: string }} violation 観点・内容
 * @returns {object} 違反
 */
function absenceViolation(doc, { aspect, message }) {
  return {
    aspect,
    line: 1,
    message: `${message}（見出し ${doc.headings.length} 件を確認した）`,
    quote: (doc.lines[0] ?? '').trim()
  }
}

/**
 * 節が「該当なし」と明記しているかを見る。ポリシーが許す節では、これがあるとき表を求めない。
 *
 * @param {string[]} body 節の本文
 * @returns {boolean} 明記していれば true
 */
function declaresNone(body) {
  return body.some((line) => {
    const text = normalizeCell(line)
    return text.includes('該当なし') || /^なし([。、]|$)/.test(text)
  })
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

  for (const spec of TABLE_SPECS) {
    const heading = findHeading(doc.headings, spec.heading)
    if (!heading) {
      violations.push(
        absenceViolation(doc, {
          aspect: ASPECTS.tableDefinition,
          message: `「${spec.heading}」の見出しが無い。この表を前提とした検査が成立しない`
        })
      )
      continue
    }

    const range = sectionRange(doc, heading)
    const inSection = doc.tables.filter(
      (table) => table.line > range.start && table.line <= range.end
    )
    if (inSection.length === 0) {
      if (spec.allowNoneDeclaration && declaresNone(sectionBody(doc, heading))) continue
      violations.push(
        violationAt(doc, {
          aspect: ASPECTS.tableDefinition,
          line: heading.line,
          message: `「${spec.heading}」に表が無い。箇条書きで書くと、この表を見る検査が素通りする`
        })
      )
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
    violations.push(
      violationAt(doc, {
        aspect: ASPECTS.tableDefinition,
        line: closest.line,
        message: `「${spec.heading}」に想定した列が無い（不足: ${missing.join('・')}）`
      })
    )
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
 * @param {object} doc parseMarkdown の結果
 * @param {Record<string, object>} tables checkTableDefinitions が返した表
 * @returns {object[]} 違反
 */
function checkIdReferences(doc, tables) {
  const violations = []

  for (const reference of ID_REFERENCES) {
    const source = tables[reference.from]
    const target = tables[reference.to]
    if (!source || !target) continue

    const validIds = new Set(columnCells(target, 'ID').map((cell) => cell.value))
    for (const cell of columnCells(source, reference.column)) {
      for (const token of referenceTokens(cell.value)) {
        if (validIds.has(token)) continue
        violations.push(
          violationAt(doc, {
            aspect: ASPECTS.idReference,
            line: cell.line,
            message: `${reference.column} の「${token}」は${reference.toLabel}の ID 列に実在しない`
          })
        )
      }
    }
  }

  return violations
}

/**
 * 入出力情報一覧の `内容` 列から属性名を切り出す。
 *
 * 区切りは読点・カンマ・中黒・スラッシュ・縦棒・改行タグ・空白。丸括弧の補足（`会員ID（8桁）`）は
 * 属性名ではないので落とす。切り出しは自然文のパースなので、取りこぼしも取りすぎも起きる。
 * だから結果は違反ではなく警告に留める（ファイル冒頭の注記）。
 *
 * @param {string} cell `内容` セルの値
 * @returns {string[]} 属性名
 */
function contentAttributes(cell) {
  return normalizeCell(cell)
    .replace(/<br\s*\/?>/gi, '、')
    .replace(/[（(][^）)]*[）)]/g, ' ')
    .split(/[、，,／/・|｜\s]+/)
    .map((token) => token.trim())
    .filter(
      (token) => token !== '' && !NO_REFERENCE_TOKENS.has(token) && !NON_ATTRIBUTE_TOKENS.has(token)
    )
}

/**
 * ビジネスルールが1行も無い属性を警告として集める。
 *
 * ルールの不在は読んでも目に入らないが、`内容` 列の属性名とビジネスルール一覧の語の差集合を取るのは
 * 機械の仕事である（policy「あるべきルールの不在の判定」）。同じ属性が複数行に現れても警告は1件にまとめる。
 *
 * @param {{ source: string }} input 対象の全文
 * @returns {{ line: number, message: string, quote: string }[]} 警告（違反ではない）
 */
export function findAttributeWarnings({ source }) {
  const doc = parseMarkdown(source)
  const { tables } = checkTableDefinitions(doc)
  if (!tables.io || !tables.businessRule) return []

  const ruleText = tables.businessRule.rows.map((row) => row.cells.join(' ')).join('\n')
  const warnings = []
  const seen = new Set()

  for (const cell of columnCells(tables.io, '内容')) {
    for (const attribute of contentAttributes(cell.value)) {
      if (seen.has(attribute) || ruleText.includes(attribute)) continue
      seen.add(attribute)
      warnings.push({
        line: cell.line,
        message: `「${attribute}」を縛るビジネスルールがビジネスルール一覧に1行も無い`,
        quote: (doc.lines[cell.line - 1] ?? '').trim()
      })
    }
  }

  return warnings
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
 * @param {object} doc parseMarkdown の結果
 * @param {Record<string, object>} tables checkTableDefinitions が返した表
 * @param {{ symbol: string, name: string }[]} classifications 非機能要件の分類
 * @returns {object[]} 違反
 */
function checkAcceptanceTargets(doc, tables, classifications) {
  if (!tables.acceptance) return []

  const allowed = acceptanceTargetValues(tables, classifications)
  return columnCells(tables.acceptance, '検証対象')
    .filter((cell) => cell.value !== '' && !allowed.some((value) => cell.value.includes(value)))
    .map((cell) =>
      violationAt(doc, {
        aspect: ASPECTS.idReference,
        line: cell.line,
        message: `検証対象の「${cell.value}」が、機能ID・業務名・SLO・非機能の分類名のいずれにも解決できない`
      })
    )
}

/**
 * 受入基準が Must・Should の機能を漏れなくカバーしているかを差集合で検査する。
 *
 * @param {object} doc parseMarkdown の結果
 * @param {Record<string, object>} tables checkTableDefinitions が返した表
 * @returns {object[]} 違反
 */
function checkAcceptanceCoverage(doc, tables) {
  const { functionList, acceptance } = tables
  if (!functionList || !acceptance) return []

  const priorities = columnCells(functionList, '優先度')
  const mustCover = priorities.filter((cell) => COVERED_PRIORITY_PATTERN.test(cell.value))
  if (mustCover.length === 0) {
    return [
      violationAt(doc, {
        aspect: ASPECTS.acceptanceCoverage,
        line: functionList.line,
        message:
          '優先度が Must/Should・高/中 のいずれの語彙でも書かれておらず、受入基準のカバレッジを判定できない'
      })
    ]
  }

  const ids = columnCells(functionList, '機能ID')
  const covered = new Set(
    columnCells(acceptance, '検証対象').flatMap((cell) => referenceTokens(cell.value))
  )

  return mustCover
    .map((cell) => ids.find((id) => id.line === cell.line))
    .filter((id) => id && id.value !== '' && !covered.has(id.value))
    .map((id) =>
      violationAt(doc, {
        aspect: ASPECTS.acceptanceCoverage,
        line: id.line,
        message: `${id.value} は Must・Should だが、受入基準の検証対象に無い`
      })
    )
}

/**
 * 空欄を許さない列の空セルと、優先度に添える理由の欠落を検査する。
 *
 * @param {object} doc parseMarkdown の結果
 * @returns {object[]} 違反
 */
function checkEmptyCells(doc) {
  const violations = []

  for (const table of doc.tables) {
    for (const column of NON_EMPTY_COLUMNS) {
      for (const cell of columnCells(table, column)) {
        if (cell.value !== '') continue
        violations.push(
          violationAt(doc, {
            aspect: ASPECTS.emptyCell,
            line: cell.line,
            message: `${column} が空。書き忘れなのか該当が無いのかを読み手が区別できない`
          })
        )
      }
    }
    violations.push(...checkPriorityReason(doc, table))
  }

  return violations
}

/**
 * 優先度の列を持つ表に、理由の列があり埋まっているかを検査する（policy「優先順位」）。
 *
 * @param {object} doc parseMarkdown の結果
 * @param {object} table 表
 * @returns {object[]} 違反
 */
function checkPriorityReason(doc, table) {
  if (columnIndex(table, '優先度') === -1) return []

  const reasonColumn = table.headers.find((header) => header.includes('理由'))
  if (!reasonColumn) {
    return [
      violationAt(doc, {
        aspect: ASPECTS.emptyCell,
        line: table.line,
        message: '優先度の列があるのに理由の列が無い。優先度がスコープ交渉の根拠にならない'
      })
    ]
  }

  return columnCells(table, reasonColumn)
    .filter((cell) => cell.value === '')
    .map((cell) =>
      violationAt(doc, {
        aspect: ASPECTS.emptyCell,
        line: cell.line,
        message: `${reasonColumn} が空。優先度の根拠がたどれない`
      })
    )
}

/**
 * ポリシーの「項目一覧」から必須・条件付き項目を抽出する。
 *
 * @param {object} policyDoc ポリシーの解析結果
 * @returns {{ items: { name: string, category: string }[], error: string | null }} 項目と抽出できない理由
 */
function parsePolicyItems(policyDoc) {
  const heading = findHeading(policyDoc.headings, '項目一覧')
  if (!heading) return { items: [], error: '「項目一覧」の見出しが無い' }

  const range = sectionRange(policyDoc, heading)
  const table = policyDoc.tables.find(
    (candidate) => candidate.line > range.start && candidate.line <= range.end
  )
  if (!table) return { items: [], error: '「項目一覧」に表が無い' }
  if (columnIndex(table, '項目') === -1 || columnIndex(table, '区分') === -1) {
    return { items: [], error: '「項目一覧」に `項目`・`区分` 列が無い' }
  }

  const names = columnCells(table, '項目')
  const categories = columnCells(table, '区分')
  const items = names.map((name, index) => ({
    name: name.value,
    category: categories[index]?.value ?? ''
  }))
  return { items, error: null }
}

/**
 * ポリシーの機能要件サブ項目から、区分が必須の図を抽出する。
 *
 * @param {object} policyDoc ポリシーの解析結果
 * @returns {{ names: string[], error: string | null }} 図の名前と抽出できない理由
 */
function parseRequiredDiagrams(policyDoc) {
  const heading = findHeading(policyDoc.headings, '機能要件')
  if (!heading) return { names: [], error: '「機能要件」の見出しが無い' }

  const range = sectionRange(policyDoc, heading)
  const table = policyDoc.tables.find(
    (candidate) =>
      candidate.line > range.start &&
      candidate.line <= range.end &&
      columnIndex(candidate, 'サブ項目') !== -1 &&
      columnIndex(candidate, '区分') !== -1
  )
  if (!table) return { names: [], error: '「機能要件」に `サブ項目`・`区分` を持つ表が無い' }

  const names = columnCells(table, 'サブ項目')
  const categories = columnCells(table, '区分')
  const required = names
    .filter((name, index) => name.value.includes('図') && categories[index]?.value === '必須')
    .map((name) => name.value)
  if (required.length === 0) return { names: [], error: '区分が必須の図が1つも読み取れない' }
  return { names: required, error: null }
}

/**
 * 項目名の別名を返す。`ステークホルダー／関係者` のような併記に対応する。
 *
 * @param {string} itemName 項目名
 * @returns {string[]} 照合に使う名前
 */
function itemAliases(itemName) {
  const base = stripParenthetical(itemName)
  return [itemName, ...base.split('／')].map((name) => name.trim()).filter(Boolean)
}

/**
 * 項目に対応する見出しがあるかを見る。
 *
 * @param {object} doc parseMarkdown の結果
 * @param {string[]} aliases 照合に使う名前
 * @returns {boolean} あれば true
 */
function hasHeadingFor(doc, aliases) {
  return doc.headings.some((heading) => aliases.some((alias) => heading.text.includes(alias)))
}

/**
 * 項目について「該当なし」の宣言があるかを見る。
 *
 * @param {object} doc parseMarkdown の結果
 * @param {string[]} aliases 照合に使う名前
 * @returns {boolean} あれば true
 */
function hasNoneDeclarationFor(doc, aliases) {
  return doc.textLines.some(
    ({ text }) => text.includes('該当なし') && aliases.some((alias) => text.includes(alias))
  )
}

/**
 * 必須項目の見出しと、条件付き項目の判定の跡を検査する。
 *
 * @param {object} doc parseMarkdown の結果
 * @param {{ name: string, category: string }[]} items ポリシーの項目一覧
 * @returns {object[]} 違反
 */
function checkRequiredItems(doc, items) {
  const violations = []

  for (const item of items) {
    const aliases = itemAliases(item.name)
    if (hasHeadingFor(doc, aliases)) continue

    if (item.category.startsWith('必須')) {
      violations.push(
        absenceViolation(doc, {
          aspect: ASPECTS.requiredItems,
          message: `必須項目「${item.name}」の見出しが無い`
        })
      )
      continue
    }

    if (item.category.startsWith('条件付き') && !hasNoneDeclarationFor(doc, aliases)) {
      violations.push(
        absenceViolation(doc, {
          aspect: ASPECTS.requiredItems,
          message: `条件付き項目「${item.name}」に、本文も「該当なし・理由」も無い`
        })
      )
    }
  }

  return violations
}

/**
 * 非機能要件の分類が、節または「該当なし・理由」として立っているかを検査する。
 *
 * @param {object} doc parseMarkdown の結果
 * @param {{ symbol: string, name: string }[]} classifications 非機能要件の分類
 * @returns {object[]} 違反
 */
function checkNonFunctionalCoverage(doc, classifications) {
  return classifications
    .filter(({ name }) => !hasHeadingFor(doc, [name]) && !hasNoneDeclarationFor(doc, [name]))
    .map(({ symbol, name }) =>
      absenceViolation(doc, {
        aspect: ASPECTS.nonFunctional,
        message: `非機能要件の分類「${symbol}. ${name}」が節としても「該当なし・理由」としても無い`
      })
    )
}

/**
 * 区分が必須の図に、Mermaid ブロックと凡例があるかを検査する。
 *
 * @param {object} doc parseMarkdown の結果
 * @param {string[]} diagramNames 必須の図の名前
 * @returns {object[]} 違反
 */
function checkRequiredDiagrams(doc, diagramNames) {
  const violations = []

  for (const name of diagramNames) {
    const heading = findHeading(doc.headings, name)
    if (!heading) {
      violations.push(
        absenceViolation(doc, {
          aspect: ASPECTS.requiredDiagram,
          message: `必須の図「${name}」の節が無い`
        })
      )
      continue
    }

    const body = sectionBody(doc, heading)
    if (!body.some((line) => /^\s*```mermaid/.test(line))) {
      violations.push(
        violationAt(doc, {
          aspect: ASPECTS.requiredDiagram,
          line: heading.line,
          message: `必須の図「${name}」に mermaid ブロックが無い`
        })
      )
      continue
    }
    if (!body.some((line) => line.includes('凡例'))) {
      violations.push(
        violationAt(doc, {
          aspect: ASPECTS.requiredDiagram,
          line: heading.line,
          message: `必須の図「${name}」の直下に凡例の Note が無い`
        })
      )
    }
  }

  return violations
}

/**
 * 書式（見積もりの混入・解消期限・取扱量／頻度・ルールのタイプ）を検査する。
 *
 * @param {object} doc parseMarkdown の結果
 * @param {Record<string, object>} tables checkTableDefinitions が返した表
 * @returns {object[]} 違反
 */
function checkFormats(doc, tables) {
  const violations = []

  for (const { text, line } of doc.textLines) {
    for (const { pattern, message } of ESTIMATE_PATTERNS) {
      if (pattern.test(text)) {
        violations.push(violationAt(doc, { aspect: ASPECTS.format, line, message }))
      }
    }
  }

  if (tables.openQuestion) {
    for (const cell of columnCells(tables.openQuestion, '解消期限')) {
      if (!DEADLINE_DATE_PATTERN.test(cell.value)) continue
      violations.push(
        violationAt(doc, {
          aspect: ASPECTS.format,
          line: cell.line,
          message: `解消期限「${cell.value}」が日付で書かれている。工程（設計前・リリース前）で書く`
        })
      )
    }
  }

  if (tables.io) {
    for (const column of ['取扱量', '頻度']) {
      for (const cell of columnCells(tables.io, column)) {
        if (/[0-9０-９]/.test(cell.value) || OCCASION_PATTERN.test(cell.value)) continue
        violations.push(
          violationAt(doc, {
            aspect: ASPECTS.format,
            line: cell.line,
            message: `${column}「${cell.value}」が数値でも発生契機でもない。測定可能な前提条件にならない`
          })
        )
      }
    }
  }

  if (tables.businessRule) {
    for (const cell of columnCells(tables.businessRule, 'タイプ')) {
      if (BUSINESS_RULE_TYPES.includes(cell.value)) continue
      violations.push(
        violationAt(doc, {
          aspect: ASPECTS.format,
          line: cell.line,
          message: `タイプ「${cell.value}」が ${BUSINESS_RULE_TYPES.join('・')} 以外`
        })
      )
    }
  }

  return violations
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
 * 判定基準（ポリシー・カタログ）が読めるかを検査する。読めないまま通すと検査が無言で腐る。
 *
 * @param {{ policyError: string | null, diagramError: string | null, classificationCount: number }} state 抽出の結果
 * @returns {object[]} 違反
 */
function checkCriteriaAvailable({ policyError, diagramError, classificationCount }) {
  const violations = []

  if (policyError) {
    violations.push({
      aspect: ASPECTS.tableDefinition,
      line: 1,
      message: `${POLICY_PATH} から必須・条件付き項目を抽出できない`,
      quote: policyError
    })
  }
  if (diagramError) {
    violations.push({
      aspect: ASPECTS.tableDefinition,
      line: 1,
      message: `${POLICY_PATH} から必須の図を抽出できない`,
      quote: diagramError
    })
  }
  if (classificationCount === 0) {
    violations.push({
      aspect: ASPECTS.tableDefinition,
      line: 1,
      message: `${NON_FUNCTIONAL_CATALOG_PATH} から非機能要件の分類を抽出できない`,
      quote: 'カタログが読めない、または `## A. 〜` 形式の見出しが無い'
    })
  }

  return violations
}

/**
 * 要件定義書1本を検査する。副作用を持たないので、あとからテストを足せる。
 *
 * @param {{ source: string, policySource: string | null, catalogSource: string | null }} input 対象・ポリシー・カタログの全文
 * @returns {{ aspect: string, line: number, message: string, quote: string }[]} 違反
 */
export function findViolations({ source, policySource, catalogSource }) {
  const doc = parseMarkdown(source)
  const policyDoc = parseMarkdown(policySource ?? '')
  const { items, error: policyError } = parsePolicyItems(policyDoc)
  const { names: diagramNames, error: diagramError } = parseRequiredDiagrams(policyDoc)
  const classifications = parseClassifications(catalogSource ?? '')

  const { tables, violations } = checkTableDefinitions(doc)
  violations.push(
    ...checkCriteriaAvailable({
      policyError,
      diagramError,
      classificationCount: classifications.length
    })
  )
  violations.push(...checkRequiredItems(doc, items))
  violations.push(...checkNonFunctionalCoverage(doc, classifications))
  violations.push(...checkRequiredDiagrams(doc, diagramNames))
  violations.push(...checkIdReferences(doc, tables))
  violations.push(...checkAcceptanceTargets(doc, tables, classifications))
  violations.push(...checkAcceptanceCoverage(doc, tables))
  violations.push(...checkEmptyCells(doc))
  violations.push(...checkFormats(doc, tables))

  return violations.sort((left, right) => left.line - right.line)
}

/**
 * 警告を出力する。違反と混ぜないよう見出しで分け、exit code を変えないことを出力自体に書く。
 *
 * @param {string} targetPath 対象パス
 * @param {{ line: number, message: string, quote: string }[]} warnings 警告
 */
function printWarnings(targetPath, warnings) {
  if (warnings.length === 0) return

  console.log(
    `\n[警告] ビジネスルールが1行も無い属性が ${warnings.length} 件あります（違反ではありません。exit code は変わりません）。`
  )
  for (const warning of warnings) {
    console.log(`\n  ${targetPath}:${warning.line}`)
    console.log(`    ${warning.message}`)
    console.log(`    原文: ${warning.quote}`)
  }
  console.log(
    '\n  これは候補です。属性名の切り出しは自然文のパースなので、ルールが不要な語や表記の違うルールが混じります。'
  )
  console.log('  違反かどうかは AI レビューが本文を読んで判定します。')
}

/** 判定した観点名を出力する。AI レビューはこの一覧を担当から外す */
function printAspects() {
  console.log('\nこのスクリプトが判定した観点:')
  for (const aspect of Object.values(ASPECTS)) {
    console.log(`  - ${aspect}`)
  }
}

/**
 * リポジトリ内のファイルを読む。無ければ null。
 *
 * @param {string} relativePath リポジトリ相対パス
 * @returns {string | null} 全文
 */
function readRepoFile(relativePath) {
  const path = join(repoRoot, relativePath)
  return existsSync(path) ? readFileSync(path, 'utf8') : null
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

  const source = readFileSync(absolutePath, 'utf8')
  const violations = findViolations({
    source,
    policySource: readRepoFile(POLICY_PATH),
    catalogSource: readRepoFile(NON_FUNCTIONAL_CATALOG_PATH)
  })
  const warnings = findAttributeWarnings({ source })

  if (violations.length === 0) {
    console.log(`${targetPath} は機械判定した観点をすべて満たしています。`)
    printWarnings(targetPath, warnings)
    printAspects()
    return
  }

  console.error(`${targetPath} に機械判定できる違反が ${violations.length} 件あります。`)
  for (const violation of violations) {
    console.error(`\n  ${targetPath}:${violation.line} [${violation.aspect}]`)
    console.error(`    ${violation.message}`)
    console.error(`    原文: ${violation.quote}`)
  }
  printWarnings(targetPath, warnings)
  printAspects()
  process.exit(1)
}

main()
