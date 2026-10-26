#!/usr/bin/env node
// 責務: 各 ADR（NNN-*.md）の frontmatter から、同じディレクトリの adr-index.md の一覧テーブルを生成する。
//   frontmatter を SSOT とし、手動転記によるドリフトを構造的になくす（Issue #50）。

import { readFileSync, writeFileSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

import prettier from 'prettier'

import { BusinessError } from './lib/errors.mjs'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = join(scriptDirectory, '..')
// 一覧表を持つ ADR ディレクトリ。samples/ の ADR も同じ生成に乗せ、表を手で保つ場所を残さない。
const ADR_DIRECTORIES = [join(repositoryRoot, 'docs/adr'), join(repositoryRoot, 'samples/docs/adr')]

// テーブルを差し込む位置を示すマーカー。この2行の間だけを生成が上書きし、前後の説明文は手で保つ。
const START_MARKER = '<!-- ADR_INDEX_TABLE:START -->'
const END_MARKER = '<!-- ADR_INDEX_TABLE:END -->'

// ADR 番号の書式（3桁）。ファイル名の接頭辞と supersededBy は同じ番号を指すので、1か所で持つ
const ADR_NUMBER_SOURCE = String.raw`\d{3}`
const ADR_FILE_NAME_PATTERN = new RegExp(`^(${ADR_NUMBER_SOURCE})-.*\\.md$`)
const ADR_NUMBER_PATTERN = new RegExp(`^${ADR_NUMBER_SOURCE}$`)

// ファイル先頭の frontmatter（--- で囲まれた YAML）。1番目のグループが中身
const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n---\n?/

// status は機械キー（ASCII enum）を SSOT にし、表示だけ日本語へ写す。
// 表示語の言い換えが status 値の比較ロジックに波及しないよう、機械キーと表示を分離する。
const STATUS_LABEL_BY_KEY = {
  proposed: '提案',
  accepted: '承認',
  rejected: '却下',
  deprecated: '廃止',
  superseded: '置換'
}

/**
 * CLI として実行したときの本体。ADR ディレクトリごとに一覧表を生成して書き込む。
 *
 * @returns {Promise<void>}
 * @throws {BusinessError} ADR の frontmatter・H1 見出しが不正なとき、adr-index.md にマーカーが無いとき
 */
async function runCli() {
  for (const adrDirectory of ADR_DIRECTORIES) {
    const indexPath = toIndexPath(adrDirectory)
    const formattedIndexContent = await formatWithPrettier({
      content: renderIndex(adrDirectory),
      indexPath
    })
    writeIfChanged({ indexPath, formattedIndexContent })
  }
}

/**
 * ADR ディレクトリの一覧表ファイルのパスを返す。
 *
 * @param {string} adrDirectory ADR ディレクトリの絶対パス
 * @returns {string} 一覧表ファイル（adr-index.md）の絶対パス
 */
function toIndexPath(adrDirectory) {
  return join(adrDirectory, 'adr-index.md')
}

/**
 * 整形済みの全文をファイルと比べ、違えば書き込む。結果（再生成した／最新）を標準出力に1行出す。
 *
 * @param {{ indexPath: string, formattedIndexContent: string }} params
 *   indexPath: 書き込み先の一覧表ファイルの絶対パス / formattedIndexContent: prettier で整形済みの全文
 * @returns {void}
 */
function writeIfChanged({ indexPath, formattedIndexContent }) {
  const currentIndexContent = readFileSync(indexPath, 'utf8')

  if (formattedIndexContent !== currentIndexContent) {
    writeFileSync(indexPath, formattedIndexContent)
    console.log(`${indexPath} を再生成しました。`)
  } else {
    console.log(`${indexPath} は最新です（変更なし）。`)
  }
}

/**
 * 文字列を prettier 整形する（CJK 列幅を含む整形を prettier に委ねる）。
 * リポジトリの prettier 設定を indexPath 基準で解決し、`prettier --check .` と結果を一致させる。
 *
 * @param {{ content: string, indexPath: string }} params
 *   content: 整形前の全文 / indexPath: 整形基準にする一覧表ファイルの絶対パス
 * @returns {Promise<string>} 整形後の全文
 */
async function formatWithPrettier({ content, indexPath }) {
  const prettierConfig = await prettier.resolveConfig(indexPath)
  return prettier.format(content, { ...prettierConfig, filepath: indexPath })
}

/**
 * 既存 adr-index.md のマーカー間だけを生成テーブルへ差し替えた全文を作る。
 *
 * @param {string} adrDirectory ADR ディレクトリの絶対パス
 * @returns {string} 差し替え後の全文
 * @throws {BusinessError} adr-index.md に START / END マーカーが無いとき、または ADR の内容が不正なとき（`collectAdrs`）
 */
function renderIndex(adrDirectory) {
  const currentIndexContent = readFileSync(toIndexPath(adrDirectory), 'utf8')
  const startMarkerIndex = currentIndexContent.indexOf(START_MARKER)
  const endMarkerIndex = currentIndexContent.indexOf(END_MARKER)
  if (startMarkerIndex === -1 || endMarkerIndex === -1) {
    throw new BusinessError(`adr-index.md に ${START_MARKER} / ${END_MARKER} マーカーが必要です`)
  }
  const beforeTable = currentIndexContent.slice(0, startMarkerIndex + START_MARKER.length)
  const afterTable = currentIndexContent.slice(endMarkerIndex)
  return `${beforeTable}\n${buildTable(collectAdrs(adrDirectory))}\n${afterTable}`
}

/**
 * ADR 素材からマークダウンの表を組み立てる（列幅の整形は prettier に任せる）。
 *
 * @param {ReturnType<typeof toAdrEntry>[]} adrs
 * @returns {string} テーブル文字列
 */
function buildTable(adrs) {
  const header = '| No. | タイトル | ステータス | 日付 |'
  const separator = '| --- | --- | --- | --- |'
  const rows = adrs.map((adr) => {
    let statusLabel = STATUS_LABEL_BY_KEY[adr.status]
    if (adr.status === 'superseded') statusLabel += `（→ ADR-${adr.supersededBy}）`
    return `| ${adr.number} | [${adr.title}](${adr.fileName}) | ${statusLabel} | ${adr.date} |`
  })
  return [header, separator, ...rows].join('\n')
}

/**
 * 指定ディレクトリ配下の ADR ファイル（NNN-*.md）を番号昇順で読み、テーブル行の素材を作る。
 *
 * @param {string} adrDirectory ADR ディレクトリの絶対パス
 * @returns {ReturnType<typeof toAdrEntry>[]}
 * @throws {BusinessError} ADR の内容が不正なとき（`toAdrEntry`）
 */
function collectAdrs(adrDirectory) {
  const adrFileNames = readdirSync(adrDirectory).filter((name) => ADR_FILE_NAME_PATTERN.test(name))
  const adrs = adrFileNames.map((fileName) =>
    toAdrEntry({ fileName, content: readFileSync(join(adrDirectory, fileName), 'utf8') })
  )
  adrs.sort((oneAdr, otherAdr) => oneAdr.number.localeCompare(otherAdr.number))
  return adrs
}

/**
 * 1 つの ADR ファイルの内容を検証済みのテーブル行素材へ変換する（FS に触れない純関数）。
 *
 * @param {{ fileName: string, content: string }} params
 *   fileName: ファイル名（NNN-*.md） / content: ファイル全文
 * @returns {{ number: string, title: string, fileName: string, status: string, date: string, supersededBy?: string }}
 * @throws {BusinessError} frontmatter の status が無い・未知のとき、date が YYYY-MM-DD でないとき、status が superseded
 *   なのに supersededBy が3桁の番号でないとき、H1 見出し（タイトル）が無いとき
 */
function toAdrEntry({ fileName, content }) {
  const frontmatter = parseFrontmatter(content)
  const number = fileName.match(ADR_FILE_NAME_PATTERN)[1]

  assertValidFrontmatter({ fileName, frontmatter })
  const title = extractTitle(content)
  if (!title) throw new BusinessError(`${fileName}: H1 見出し（タイトル）がありません`)

  return {
    number,
    title,
    fileName,
    status: frontmatter.status,
    date: frontmatter.date,
    supersededBy: frontmatter.supersededBy
  }
}

/**
 * ADR の frontmatter が、一覧表に載せられる形かを検証する。
 *
 * 値が無いときと、あっても書式が違うときで、メッセージを分ける（直すのが「行を足す」か「値を直す」かが分かる）。
 *
 * @param {{ fileName: string, frontmatter: Record<string, string> }} params
 *   fileName: ファイル名（メッセージに出す） / frontmatter: `parseFrontmatter` の結果
 * @returns {void}
 * @throws {BusinessError} status が無い・未知のとき、date が無い・YYYY-MM-DD でないとき、status が superseded なのに
 *   supersededBy が無い・3桁の番号でないとき
 */
function assertValidFrontmatter({ fileName, frontmatter }) {
  const { status, date, supersededBy } = frontmatter
  if (status === undefined)
    throw new BusinessError(`${fileName}: frontmatter に status がありません`)
  if (!STATUS_LABEL_BY_KEY[status]) {
    throw new BusinessError(
      `${fileName}: 未知の status "${status}"（許容: ${Object.keys(STATUS_LABEL_BY_KEY).join(' / ')}）`
    )
  }
  if (date === undefined) throw new BusinessError(`${fileName}: frontmatter に date がありません`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new BusinessError(`${fileName}: date は YYYY-MM-DD の日付で書いてください: "${date}"`)
  }
  if (status !== 'superseded') return
  if (supersededBy === undefined) {
    throw new BusinessError(
      `${fileName}: status が superseded なら supersededBy（置換先ADR番号）が必要です`
    )
  }
  if (!ADR_NUMBER_PATTERN.test(supersededBy)) {
    throw new BusinessError(
      `${fileName}: supersededBy は置換先ADRの3桁の番号で書いてください: "${supersededBy}"`
    )
  }
}

/**
 * H1 見出しから表示用タイトルを取り出す（先頭の "ADR-NNN: " は落とす）。
 *
 * @param {string} content ファイル全文
 * @returns {string} タイトル（H1 見出しが無ければ空文字）
 */
function extractTitle(content) {
  // frontmatter の YAML コメント（`# ...`）を H1 と取り違えないよう、frontmatter を外してから探す
  const body = content.replace(FRONTMATTER_PATTERN, '')
  const heading = body.match(/^#\s+(.+)$/m)
  if (!heading) return ''
  return heading[1].replace(/^ADR-\d+:\s*/, '').trim()
}

/**
 * ADR ファイルの先頭 frontmatter を最小パースする。
 * js-yaml を足さない方針（dependency-policy）に沿い、`key: value` 行だけを読む。
 *
 * @param {string} content ファイル全文
 * @returns {Record<string, string>} frontmatter のキー・値（frontmatter が無ければ空）
 */
function parseFrontmatter(content) {
  const match = content.match(FRONTMATTER_PATTERN)
  if (!match) return {}
  const frontmatterByKey = {}
  for (const line of match[1].split('\n')) {
    const keyValueMatch = line.match(/^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/)
    if (keyValueMatch) frontmatterByKey[keyValueMatch[1]] = keyValueMatch[2].trim()
  }
  return frontmatterByKey
}

runCli().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
