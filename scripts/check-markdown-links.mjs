#!/usr/bin/env node
// 責務: Git が無視しない Markdown に書かれた相対リンクの参照先が実在するかを検査する。
//   リンク切れはレビューで拾う欠陥ではなく機械が判定できる事実であり、放置すると静かに溜まる（Issue #107）。
//   加えて、テンプレート同期で利用先へ届く Markdown から docs/adr/NNN-*.md への相対リンクも落とす。
//   docs/adr/ は同期対象外（sync-template.sh）なので、相対リンクのまま届くと利用先でリンク切れになる（Issue #726）。

import { existsSync, readFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { dirname, join, relative, resolve, sep } from 'path'
import { fileURLToPath } from 'url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

// [text](path) と ![alt](path) の両方。タイトル付き（"..."）も許す。
const LINK_PATTERN = /!?\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g

// 参照先がリポジトリ内に無いのが正常なリンク。実在検査の対象から外す。
const EXTERNAL_PATTERN = /^(https?:|mailto:|tel:|#|<)/

// テンプレート同期の対象外である docs/adr/ の ADR 本体（adr-template.md・adr-index.md は含まない）。
const ADR_FILE_PATTERN = /^docs\/adr\/\d{3}-.*\.md$/

/**
 * 1行から検査対象のリンク先を取り出す。
 *
 * 例示（実在しないファイルをリンク記法で書いたもの）はバッククォートで囲む約束にしており、
 * インラインコードを落とすことが偽陽性対策そのものになっている。
 *
 * @param {string} line 1行分の本文（コードフェンス内でないこと）
 * @returns {string[]} リンク先のパス
 */
function extractLinkTargets(line) {
  const withoutInlineCode = line.replace(/`+[^`]*`+/g, '')
  return [...withoutInlineCode.matchAll(LINK_PATTERN)].map((match) => match[1])
}

/**
 * リンク先を実ファイルのパスへ解決する。検査対象外なら null を返す。
 *
 * @param {string} target リンク先の文字列
 * @param {string} markdownPath リンク元 Markdown のリポジトリ相対パス
 * @returns {string | null} 解決した絶対パス
 */
function resolveTarget(target, markdownPath) {
  if (EXTERNAL_PATTERN.test(target)) return null

  // 同一文書内アンカーは実在検査の対象外。ファイル部分だけを見る。
  const [path] = target.split('#')
  if (!path) return null

  let decoded = path
  try {
    decoded = decodeURIComponent(path)
  } catch {
    // 不正なパーセントエンコードは、そのままのパスとして扱えば実在しないものとして落ちる
  }

  const base = decoded.startsWith('/') ? repoRoot : join(repoRoot, dirname(markdownPath))
  return resolve(base, decoded.replace(/^\//, ''))
}

/**
 * 絶対パスが docs/adr/NNN-*.md（ADR 本体）を指すかを判定する。
 *
 * @param {string} absolutePath resolveTarget が返す絶対パス
 * @returns {boolean}
 */
function isAdrFilePath(absolutePath) {
  const repoRelative = relative(repoRoot, absolutePath).split(sep).join('/')
  return ADR_FILE_PATTERN.test(repoRelative)
}

/**
 * bash の `readonly NAME=(...)` 形式の配列リテラルから、シングルクォート文字列を取り出す。
 *
 * @param {string} scriptSource sync-template.sh の全文
 * @param {string} arrayName 配列変数名
 * @returns {string[]} 配列の要素
 */
function readBashArray(scriptSource, arrayName) {
  const match = scriptSource.match(new RegExp(`readonly ${arrayName}=\\(([^)]*)\\)`, 's'))
  if (!match) throw new Error(`scripts/sync-template.sh に ${arrayName} が見つかりません`)
  return [...match[1].matchAll(/'([^']*)'/g)].map((m) => m[1])
}

/**
 * sync-template.sh の除外パス設定を読む。ここを SSOT にし、除外リストの二重管理を避ける。
 *
 * @returns {{ excludePaths: string[], excludeExceptions: string[] }}
 */
function readSyncExcludeConfig() {
  const scriptSource = readFileSync(join(repoRoot, 'scripts/sync-template.sh'), 'utf8')
  return {
    excludePaths: readBashArray(scriptSource, 'EXCLUDE_PATHS'),
    excludeExceptions: readBashArray(scriptSource, 'EXCLUDE_EXCEPTIONS')
  }
}

/**
 * リポジトリ相対パスが sync-template.sh の同期対象から外れているかを判定する
 * （sync-template.sh の is_excluded と同じロジック）。
 *
 * @param {string} repoPath リポジトリ相対パス
 * @param {{ excludePaths: string[], excludeExceptions: string[] }} syncExclude
 * @returns {boolean}
 */
function isExcludedFromSync(repoPath, { excludePaths, excludeExceptions }) {
  if (excludeExceptions.includes(repoPath)) return false
  return excludePaths.some((pattern) =>
    pattern.endsWith('/') ? repoPath.startsWith(pattern) : repoPath === pattern
  )
}

/**
 * ADR リンク検査の対象（＝テンプレート同期で利用先へ届く Markdown）かを判定する。
 * samples/ は参照実装で、samples/docs/adr/ 内で完結する相対リンクを持つため対象から外す。
 *
 * @param {string} repoPath リポジトリ相対パス
 * @param {{ excludePaths: string[], excludeExceptions: string[] }} syncExclude
 * @returns {boolean}
 */
function isSyncedMarkdown(repoPath, syncExclude) {
  if (repoPath.startsWith('samples/')) return false
  return !isExcludedFromSync(repoPath, syncExclude)
}

/**
 * Markdown 1本を検査し、壊れたリンクと ADR への相対リンクを集める。
 *
 * @param {string} markdownPath リポジトリ相対パス
 * @param {string} source ファイル全文
 * @param {boolean} checkAdrLinks ADR リンク検査も行うか（同期対象の Markdown かどうか）
 * @returns {{ broken: {file: string, line: number, target: string}[], adrLinks: {file: string, line: number, target: string}[] }}
 */
function analyzeMarkdown(markdownPath, source, checkAdrLinks) {
  const broken = []
  const adrLinks = []
  let insideFence = false

  source.split('\n').forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) {
      insideFence = !insideFence
      return
    }
    if (insideFence) return

    for (const target of extractLinkTargets(line)) {
      const resolved = resolveTarget(target, markdownPath)
      if (!resolved) continue

      if (!existsSync(resolved)) {
        broken.push({ file: markdownPath, line: index + 1, target })
      } else if (checkAdrLinks && isAdrFilePath(resolved)) {
        adrLinks.push({ file: markdownPath, line: index + 1, target })
      }
    }
  })

  return { broken, adrLinks }
}

function reportBrokenLinks(broken) {
  console.error('参照先が存在しない相対リンクがあります。')
  for (const { file, line, target } of broken) {
    console.error(`  ${file}:${line} -> ${target}`)
  }
  console.error(
    '\n直し方: 参照先が正しいパスかを確認してください。実在しないファイルを指す「例示」であれば、' +
      'それはリンクではありません。`[原則](x.md)` のようにバッククォートで囲んでください。'
  )
}

function reportAdrLinkViolations(adrLinks) {
  console.error(
    'テンプレート同期で利用先へ届く Markdown から docs/adr/ への相対リンクがあります（docs/adr/ は同期対象外）。'
  )
  for (const { file, line, target } of adrLinks) {
    console.error(`  ${file}:${line} -> ${target}`)
  }
  console.error(
    '\n直し方: ADR への参照を外してください。理由を残したいときは、ADR を指さずにその本文へ書いてください。'
  )
}

function main() {
  // 検査対象は Git が無視しないものだけ。node_modules や生成物を除外する設定を持たずに済む。
  // --others --exclude-standard で、まだ追跡されていない新規 Markdown も含める（Issue #321）。
  const files = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '*.md'],
    { cwd: repoRoot, encoding: 'utf8' }
  )
    .split('\n')
    .filter(Boolean)

  const syncExclude = readSyncExcludeConfig()
  const broken = []
  const adrLinks = []

  for (const file of files) {
    const result = analyzeMarkdown(
      file,
      readFileSync(join(repoRoot, file), 'utf8'),
      isSyncedMarkdown(file, syncExclude)
    )
    broken.push(...result.broken)
    adrLinks.push(...result.adrLinks)
  }

  if (broken.length === 0 && adrLinks.length === 0) {
    console.log(
      `Markdown ${files.length} 本の相対リンクはすべて実在し、ADR への相対リンクもありません。`
    )
    return
  }

  if (broken.length > 0) reportBrokenLinks(broken)
  if (adrLinks.length > 0) reportAdrLinkViolations(adrLinks)
  process.exit(1)
}

main()
