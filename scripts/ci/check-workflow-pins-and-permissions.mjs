#!/usr/bin/env node
// 責務: `.github/workflows/*.{yml,yaml}` が次の3つの決まりを守っているかを検査する。
//   (1) 外部の `uses:` を40桁の commit SHA で固定している（タグは後から動かせるため、
//       タグ固定のままだと、乗っ取られた Action がそのまま走る）
//   (2) 最上位に `permissions: {}` を置いている（既定で権限を持たせず、job ごとに足す）
//   (3) `run:` の中に `${{ github.event.* }}`・`${{ github.head_ref }}` を直接書いていない
//       （PR タイトルやブランチ名などの外部入力がシェルのコードとして実行される。`env:` 経由で渡す）
//   `env:`・`if:`・`with:` の中の式は対象外（`run:` のシェルに直接展開されないため）。
//   `actions/github-script` の `with: script:` は JavaScript として実行されるが、今は検査しない。
//
// 機械が合否を出せる決まりなので AI のレビューに任せず、ここで判定する（policy-driven-development-policy）。
// 判定ロジックはこのファイル1ヶ所にしか置かない。ターン末ゲートと CI の2経路から npm script として呼ばれる。
// YAML を構文解析せず行で見る（外部の依存を使わないため）。行で見られない書き方（flow 形式の step）は
// 見逃さず、書き直しを求める違反にする。

import { existsSync, readdirSync, readFileSync } from 'fs'
import { dirname, join, relative } from 'path'
import { fileURLToPath } from 'url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')
const workflowsDir = join(repoRoot, '.github/workflows')

const FULL_SHA = /@[0-9a-f]{40}$/
const TOP_LEVEL_EMPTY_PERMISSIONS = /^permissions:\s*\{\s*\}\s*(#.*)?$/
const USES_LINE = /^\s*(?:-\s+)?uses:\s*(.+)$/
const RUN_LINE = /^(\s*)(-\s+)?run:\s*(.*)$/
const FLOW_STYLE_STEP = /^\s*-\s*\{.*\b(?:uses|run)\s*:/
const EXPRESSION = /\$\{\{[\s\S]*?\}\}/g
// `github.event`・`github.head_ref` の参照と、`toJSON(github)` のように `github` 全体を渡す形。
// GitHub の式は大文字小文字を区別しない。`github.event_name` や `github.sha` は含めない
const UNTRUSTED_CONTEXT =
  /\bgithub\s*(?:\.\s*(?:event|head_ref)\b|\[\s*['"](?:event|head_ref)['"]\s*\])|\bgithub\b(?!\s*[.[])/i

function main() {
  const files = listWorkflowFiles()
  const violations = files.flatMap(checkWorkflowFile)

  if (violations.length === 0) {
    console.log(`${files.length} 件の workflow が決まりを守っています。`)
    return
  }

  console.error(formatViolations(violations))
  process.exit(1)
}

/**
 * 検査対象の workflow ファイルをすべて返す。
 *
 * @returns {string[]} 絶対パス。ディレクトリが無いときは空配列（git は空ディレクトリを持たず、
 *   workflow を全部消すとディレクトリごと消えるため、それを異常にしない）
 */
function listWorkflowFiles() {
  if (!existsSync(workflowsDir)) return []

  return readdirSync(workflowsDir)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort()
    .map((name) => join(workflowsDir, name))
}

/**
 * 1ファイルを検査し、違反にファイルのパスを付けて返す。
 *
 * @param {string} workflowFilePath workflow ファイルの絶対パス
 * @returns {{ relativePath: string, lineNumber: number, message: string }[]} 違反
 *   （relativePath はリポジトリ直下からの相対パス）
 */
function checkWorkflowFile(workflowFilePath) {
  return findViolations(readFileSync(workflowFilePath, 'utf8')).map((violation) => ({
    relativePath: relative(repoRoot, workflowFilePath),
    ...violation
  }))
}

/**
 * 1ファイル分の違反をすべて返す。
 *
 * @param {string} content workflow ファイルの全文
 * @returns {{ lineNumber: number, message: string }[]} 違反（行番号順）
 */
function findViolations(content) {
  // Windows のエディタが保存した CRLF の行末が、行末の `$` に一致する正規表現を外すのを防ぐ
  const lines = content.split(/\r?\n/)

  return [
    ...findUnpinnedUses(lines),
    ...findMissingEmptyPermissions(lines),
    ...findFlowStyleSteps(lines),
    ...findUntrustedExpressionInRun(lines)
  ].sort((a, b) => a.lineNumber - b.lineNumber)
}

/**
 * 違反を人間と AI の両方が読める文章にする。
 *
 * @param {{ relativePath: string, lineNumber: number, message: string }[]} violations 違反
 * @returns {string} 報告文
 */
function formatViolations(violations) {
  return [
    'workflow が決まりに反しています。',
    ...violations.map(
      ({ relativePath, lineNumber, message }) => `  ${relativePath}:${lineNumber}: ${message}`
    ),
    '',
    '直し方: 外部の Action は `uses: owner/repo@<40桁のSHA> # <タグ>` にし、最上位に `permissions: {}` を置き、',
    'run: に使う外部入力は `env:` に渡してシェル変数（`"$VAR"`）で読んでください。'
  ].join('\n')
}

/**
 * 外部の `uses:` が40桁の SHA で固定されていない行を探す。
 *
 * @param {string[]} lines ファイルの全行
 * @returns {{ lineNumber: number, message: string }[]} 違反
 */
function findUnpinnedUses(lines) {
  const violations = []

  lines.forEach((lineText, index) => {
    if (isCommentLine(lineText)) return

    const match = USES_LINE.exec(lineText)
    if (!match) return

    const reference = match[1]
      .replace(/\s+#.*$/, '')
      .trim()
      .replace(/^['"]|['"]$/g, '')

    // ローカルの Action・ローカルの再利用可能な workflow は、実行中のコミットから読まれるので固定が要らない。
    // コンテナ参照は commit SHA でなくダイジェスト（`@sha256:`）で固定する形式なので、40桁の検査を当てない
    if (reference.startsWith('./') || reference.startsWith('docker://')) return
    if (FULL_SHA.test(reference)) return

    violations.push({
      lineNumber: index + 1,
      message: `外部の uses が40桁の SHA で固定されていません: ${reference}`
    })
  })

  return violations
}

/**
 * flow 形式の step（`- { uses: ..., run: ... }`）を探す。行で見る検査では `uses:`・`run:` を読めないため、
 * 見逃さずに違反にして、ブロック形式への書き直しを求める。
 *
 * @param {string[]} lines ファイルの全行
 * @returns {{ lineNumber: number, message: string }[]} 違反
 */
function findFlowStyleSteps(lines) {
  return lines.flatMap((lineText, index) => {
    if (isCommentLine(lineText) || !FLOW_STYLE_STEP.test(lineText)) return []

    return [
      {
        lineNumber: index + 1,
        message:
          'flow 形式の step は検査できません。ブロック形式（`- uses:`・`- run:`）で書いてください'
      }
    ]
  })
}

/**
 * 最上位に `permissions: {}` が無いときの違反を返す。
 *
 * @param {string[]} lines ファイルの全行
 * @returns {{ lineNumber: number, message: string }[]} 違反（あれば1件）
 */
function findMissingEmptyPermissions(lines) {
  const hasEmptyPermissions = lines.some((lineText) => TOP_LEVEL_EMPTY_PERMISSIONS.test(lineText))
  if (hasEmptyPermissions) return []

  return [{ lineNumber: 1, message: '最上位に `permissions: {}` がありません' }]
}

/**
 * `run:` の中に外部入力の式を直接書いた行を探す。式が複数行にまたがっても見つける。
 *
 * @param {string[]} lines ファイルの全行
 * @returns {{ lineNumber: number, message: string }[]} 違反
 */
function findUntrustedExpressionInRun(lines) {
  return lines.flatMap((lineText, index) => {
    if (isCommentLine(lineText)) return []

    const runValueLines = collectRunValueLines(lines, index)
    const runValueText = runValueLines.map(({ valueText }) => valueText).join('\n')

    return [...runValueText.matchAll(EXPRESSION)]
      .filter(([expression]) => UNTRUSTED_CONTEXT.test(expression))
      .map((match) => ({
        // 式の開始位置の手前にある改行の数が、runValueLines の何番目の行かを表す
        lineNumber:
          runValueLines[runValueText.slice(0, match.index).split('\n').length - 1].lineNumber,
        message: `run: に外部入力の式を直接書いています（env: 経由で渡す）: ${match[0]}`
      }))
  })
}

/**
 * `run:` の値（1行形式・ブロック形式とも）に属する行を集める。
 *
 * @param {string[]} lines ファイルの全行
 * @param {number} runIndex 調べる行の添字
 * @returns {{ lineNumber: number, valueText: string }[]} 値に属する行。1つ目は `run:` と同じ行の
 *   値の部分だけで、2つ目以降は行全体。`runIndex` の行が `run:` のキーでなければ空配列
 */
function collectRunValueLines(lines, runIndex) {
  const runMatch = RUN_LINE.exec(lines[runIndex])
  if (!runMatch) return []

  const [, indent, dash = '', firstValue] = runMatch
  // `- run:` のときキーは「- 」の分だけ右にある。キーより深い行が値に属する
  const keyIndent = indent.length + dash.length
  const runValueLines = [{ lineNumber: runIndex + 1, valueText: firstValue }]

  for (let next = runIndex + 1; next < lines.length; next++) {
    // 空行は値の途中にありうる
    if (lines[next].trim() !== '' && countIndent(lines[next]) <= keyIndent) break
    runValueLines.push({ lineNumber: next + 1, valueText: lines[next] })
  }

  return runValueLines
}

/**
 * 行が YAML のコメント行（行頭の空白を除いた先頭が `#`）かを返す。
 *
 * @param {string} lineText 1行
 * @returns {boolean} コメント行なら true
 */
function isCommentLine(lineText) {
  return lineText.trimStart().startsWith('#')
}

/**
 * 行頭の空白の数を返す。
 *
 * @param {string} lineText 1行
 * @returns {number} 行頭の空白の数
 */
function countIndent(lineText) {
  return lineText.length - lineText.trimStart().length
}

main()
