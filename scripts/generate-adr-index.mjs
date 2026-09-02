#!/usr/bin/env node
// 責務: 各 ADR（NNN-*.md）の frontmatter から、同じディレクトリの adr-index.md の一覧テーブルを生成する。
//   frontmatter を SSOT とし、手動転記によるドリフトを構造的になくす（Issue #50）。

import { readFileSync, writeFileSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

import prettier from 'prettier'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(scriptDir, '..')
// 一覧表を持つ ADR ディレクトリ。samples/ の ADR も同じ生成に乗せ、表を手で保つ場所を残さない。
const adrDirs = [join(repoRoot, 'docs/adr'), join(repoRoot, 'samples/docs/design/adr')]

// テーブルを差し込む位置を示すマーカー。この2行の間だけを生成が上書きし、前後の説明文は手で保つ。
const START_MARKER = '<!-- ADR_INDEX_TABLE:START -->'
const END_MARKER = '<!-- ADR_INDEX_TABLE:END -->'

// status は機械キー（ASCII enum）を SSOT にし、表示だけ日本語へ写す。
// 表示語の言い換えが status 値の比較ロジックに波及しないよう、機械キーと表示を分離する。
const STATUS_DISPLAY = {
  proposed: '提案',
  accepted: '承認',
  rejected: '却下',
  deprecated: '廃止',
  superseded: '置換'
}

/**
 * ADR ファイルの先頭 frontmatter（--- で囲まれた YAML）を最小パースする。
 * js-yaml を足さない方針（dependency-policy）に沿い、`key: value` 行だけを読む。
 * @param {string} content ファイル全文
 * @returns {Record<string, string>} frontmatter のキー・値
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return {}
  const result = {}
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/)
    if (kv) result[kv[1]] = kv[2].trim()
  }
  return result
}

/**
 * H1 見出しから表示用タイトルを取り出す（先頭の "ADR-NNN: " は落とす）。
 * @param {string} content ファイル全文
 * @returns {string} タイトル
 */
function extractTitle(content) {
  const heading = content.match(/^#\s+(.+)$/m)
  if (!heading) return ''
  return heading[1].replace(/^ADR-\d+:\s*/, '').trim()
}

/**
 * 1 つの ADR ファイルの内容を検証済みのテーブル行素材へ変換する（FS に触れない純関数）。
 * @param {string} file ファイル名（NNN-*.md）
 * @param {string} content ファイル全文
 * @returns {{ number: string, title: string, file: string, status: string, date: string, supersededBy?: string }}
 */
function toAdrEntry(file, content) {
  const front = parseFrontmatter(content)
  const number = file.match(/^(\d{3})/)[1]

  if (!front.status) throw new Error(`${file}: frontmatter に status がありません`)
  if (!STATUS_DISPLAY[front.status]) {
    throw new Error(
      `${file}: 未知の status "${front.status}"（許容: ${Object.keys(STATUS_DISPLAY).join(' / ')}）`
    )
  }
  if (!front.date) throw new Error(`${file}: frontmatter に date がありません`)
  if (front.status === 'superseded' && !front.supersededBy) {
    throw new Error(`${file}: status が superseded なら supersededBy（置換先ADR番号）が必要です`)
  }

  return {
    number,
    title: extractTitle(content),
    file,
    status: front.status,
    date: front.date,
    supersededBy: front.supersededBy
  }
}

/**
 * 指定ディレクトリ配下の ADR ファイル（NNN-*.md）を番号昇順で読み、テーブル行の素材を作る。
 * @param {string} adrDir ADR ディレクトリの絶対パス
 * @returns {ReturnType<typeof toAdrEntry>[]}
 */
function collectAdrs(adrDir) {
  const files = readdirSync(adrDir).filter((name) => /^\d{3}-.*\.md$/.test(name))
  const adrs = files.map((file) => toAdrEntry(file, readFileSync(join(adrDir, file), 'utf8')))
  adrs.sort((a, b) => a.number.localeCompare(b.number))
  return adrs
}

/**
 * ADR 素材からマークダウンの表を組み立てる（列幅の整形は prettier に任せる）。
 * @param {ReturnType<typeof toAdrEntry>[]} adrs
 * @returns {string} テーブル文字列
 */
function buildTable(adrs) {
  const header = '| No. | タイトル | ステータス | 日付 |'
  const separator = '| --- | --- | --- | --- |'
  const rows = adrs.map((adr) => {
    let status = STATUS_DISPLAY[adr.status]
    if (adr.status === 'superseded') status += `（→ ADR-${adr.supersededBy}）`
    return `| ${adr.number} | [${adr.title}](${adr.file}) | ${status} | ${adr.date} |`
  })
  return [header, separator, ...rows].join('\n')
}

/**
 * 既存 adr-index.md のマーカー間だけを生成テーブルへ差し替えた全文を作る。
 * @param {string} adrDir ADR ディレクトリの絶対パス
 * @param {string} indexPath 一覧表ファイルの絶対パス
 * @returns {string} 差し替え後の全文
 */
function renderIndex(adrDir, indexPath) {
  const current = readFileSync(indexPath, 'utf8')
  const start = current.indexOf(START_MARKER)
  const end = current.indexOf(END_MARKER)
  if (start === -1 || end === -1) {
    throw new Error(`adr-index.md に ${START_MARKER} / ${END_MARKER} マーカーが必要です`)
  }
  const before = current.slice(0, start + START_MARKER.length)
  const after = current.slice(end)
  return `${before}\n${buildTable(collectAdrs(adrDir))}\n${after}`
}

/**
 * 文字列を prettier 整形する（CJK 列幅を含む整形を prettier に委ねる）。
 * リポジトリの prettier 設定を indexPath 基準で解決し、`prettier --check .` と結果を一致させる。
 * @param {string} content 整形前の全文
 * @param {string} indexPath 整形基準にする一覧表ファイルの絶対パス
 * @returns {Promise<string>} 整形後の全文
 */
async function formatWithPrettier(content, indexPath) {
  const config = await prettier.resolveConfig(indexPath)
  return prettier.format(content, { ...config, filepath: indexPath })
}

async function main() {
  for (const adrDir of adrDirs) {
    const indexPath = join(adrDir, 'adr-index.md')
    const expected = await formatWithPrettier(renderIndex(adrDir, indexPath), indexPath)
    const actual = readFileSync(indexPath, 'utf8')

    if (expected !== actual) {
      writeFileSync(indexPath, expected)
      console.log(`${indexPath} を再生成しました。`)
    } else {
      console.log(`${indexPath} は最新です（変更なし）。`)
    }
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
