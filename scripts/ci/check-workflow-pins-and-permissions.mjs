#!/usr/bin/env node
// 責務: `.github/workflows/*.{yml,yaml}` が次の3つの決まりを守っているかを検査する。
//   (1) 外部の `uses:` を40桁の commit SHA で固定している（タグは後から動かせるため、
//       タグ固定のままだと、乗っ取られた Action がそのまま走る）。コンテナ（`uses: docker://`・
//       `jobs.<id>.container`・`jobs.<id>.services.<id>.image`）は commit SHA を持たないので、同じ理由で
//       `@sha256:<64桁>` のダイジェストで固定している。Dependabot は `docker://` を更新しないので、手で上げる
//   (2) 最上位に `permissions: {}` を置いている（既定で権限を持たせず、job ごとに足す）
//   (3) `run:` と、`actions/github-script` の `with: script:` の中に `${{ github.event.* }}`・
//       `${{ github.head_ref }}` を直接書いていない（PR タイトルやブランチ名などの外部入力が、
//       シェルや JavaScript のコードとして実行される。`env:` 経由で渡す）
//   `env:`・`if:` と、github-script の `script:` 以外の `with:` の中の式は対象外（コードとして直接展開されないため）。
//
// 機械が合否を出せる決まりなので AI のレビューに任せず、ここで判定する（policy-driven-development-policy）。
// 判定ロジックはこのファイル1ヶ所にしか置かない。ターン末ゲートと CI の2経路から npm script として呼ばれる。
// YAML を構文解析せず行で見る（外部の依存を使わないため）。行で見られない書き方（flow 形式の step・
// コンテナ指定と、github-script の値を同じ行に書いた `with:`）は見逃さず、書き直しを求める違反にする。

import { existsSync, readdirSync, readFileSync } from 'fs'
import { dirname, join, relative } from 'path'
import { fileURLToPath } from 'url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')
const workflowsDirectory = join(repoRoot, '.github/workflows')

const FULL_SHA = /@[0-9a-f]{40}$/
const FULL_DIGEST = /@sha256:[0-9a-f]{64}$/
const TOP_LEVEL_EMPTY_PERMISSIONS = /^permissions:\s*\{\s*\}\s*(#.*)?$/
const JOBS_LINE = /^jobs:\s*(#.*)?$/
const USES_LINE = /^\s*(?:-\s+)?uses:\s*(.+)$/
const RUN_LINE = /^(?<indent>\s*)(?<dash>-\s+)?run:\s*(?<firstValue>.*)$/
const SCRIPT_LINE = /^(?<indent>\s*)script:\s*(?<firstValue>.*)$/
const BLOCK_WITH_LINE = /^\s*(?:-\s+)?with:(?:\s+#.*|\s*)$/
const INLINE_WITH_LINE = /^\s*(?:-\s+)?with:\s*[^\s#]/
const GITHUB_SCRIPT_ACTION_PATTERN = /^actions\/github-script(?:@|$)/i
const BLOCK_CONTAINER_LINE = /^\s*container:(?:\s+#.*|\s*)$/
const INLINE_CONTAINER_LINE = /^\s*container:\s*(?<reference>[^\s#{].*)$/
const SERVICES_LINE = /^\s*services:(?:\s+#.*|\s*)$/
const IMAGE_LINE = /^\s*image:\s*(?<reference>[^\s#].*)$/
const FLOW_STYLE_RULES = [
  {
    pattern: /^\s*-\s*\{.*\b(?:uses|run)\s*:/,
    message:
      'flow 形式の step は検査できません。ブロック形式（`- uses:`・`- run:`）で書いてください'
  },
  {
    pattern: /^\s*[\w-]+:\s*\{.*\bimage\s*:/,
    message:
      'flow 形式のコンテナ指定は検査できません。ブロック形式（`image:` を1行）で書いてください'
  }
]
const GITHUB_EXPRESSION_PATTERN = /\$\{\{[\s\S]*?\}\}/g
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
  if (!existsSync(workflowsDirectory)) return []

  return readdirSync(workflowsDirectory)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort()
    .map((name) => join(workflowsDirectory, name))
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
    ...findUnpinnedContainerImages(lines),
    ...findMissingEmptyPermissions(lines),
    ...findFlowStyleLines(lines),
    ...findInlineGitHubScriptWith(lines),
    ...findUntrustedExpressionInCode(lines)
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
    '直し方: 外部の Action は `uses: owner/repo@<40桁のSHA> # <タグ>`、コンテナは `<イメージ>@sha256:<64桁>`',
    '（`uses:` では先頭に `docker://`）にし、最上位に `permissions: {}` を置き、run: や github-script の',
    'script: に使う外部入力は `env:` に渡して、シェル変数（`"$VAR"`）や `process.env.VAR` で読んでください。'
  ].join('\n')
}

/**
 * 外部の `uses:` が40桁の SHA（`docker://` はダイジェスト）で固定されていない行を探す。
 *
 * @param {string[]} lines ファイルの全行
 * @returns {{ lineNumber: number, message: string }[]} 違反
 */
function findUnpinnedUses(lines) {
  return lines.flatMap((lineText, index) => {
    if (isCommentLine(lineText)) return []

    const match = USES_LINE.exec(lineText)
    if (!match) return []

    const reference = parseReference(match[1])

    // ローカルの Action・ローカルの再利用可能な workflow は、実行中のコミットから読まれるので固定が要らない
    if (reference.startsWith('./')) return []
    if (reference.startsWith('docker://')) {
      return findUndigestedImage({ lineNumber: index + 1, label: 'docker:// の参照', reference })
    }
    if (FULL_SHA.test(reference)) return []

    return [
      {
        lineNumber: index + 1,
        message: `外部の uses が40桁の SHA で固定されていません: ${reference}`
      }
    ]
  })
}

/**
 * job のコンテナ（`container:`）とサービス（`services.<id>.image`）のイメージが、
 * ダイジェストで固定されていない行を探す。
 *
 * @param {string[]} lines ファイルの全行
 * @returns {{ lineNumber: number, message: string }[]} 違反
 */
function findUnpinnedContainerImages(lines) {
  return lines.flatMap((lineText, index) => {
    if (isCommentLine(lineText)) return []

    const reference = findContainerImageReference(lines, index)
    if (reference === undefined) return []

    return findUndigestedImage({ lineNumber: index + 1, label: 'コンテナのイメージ', reference })
  })
}

/**
 * 調べる行が job のコンテナかサービスのイメージを指定していれば、その参照を返す。
 *
 * @param {string[]} lines ファイルの全行
 * @param {number} lineIndex 調べる行の添字
 * @returns {string | undefined} イメージの参照。イメージを指定する行でなければ undefined
 */
function findContainerImageReference(lines, lineIndex) {
  // `container: node:20` のように、イメージだけを1行で書く形
  const inlineContainerMatch = INLINE_CONTAINER_LINE.exec(lines[lineIndex])
  if (inlineContainerMatch && isJobKey(lines, lineIndex)) {
    return parseReference(inlineContainerMatch.groups.reference)
  }

  const imageMatch = IMAGE_LINE.exec(lines[lineIndex])
  if (!imageMatch) return undefined

  const parentIndex = findParentIndex(lines, lineIndex)
  if (parentIndex === undefined) return undefined

  const isContainerImage =
    BLOCK_CONTAINER_LINE.test(lines[parentIndex]) && isJobKey(lines, parentIndex)
  const servicesIndex = findParentIndex(lines, parentIndex)
  const isServiceImage =
    servicesIndex !== undefined &&
    SERVICES_LINE.test(lines[servicesIndex]) &&
    isJobKey(lines, servicesIndex)

  return isContainerImage || isServiceImage
    ? parseReference(imageMatch.groups.reference)
    : undefined
}

/**
 * キーの行が job の直下（`jobs.<id>.<キー>`）にあるかを返す。
 *
 * @param {string[]} lines ファイルの全行
 * @param {number} keyIndex キーの行の添字
 * @returns {boolean} job の直下なら true
 */
function isJobKey(lines, keyIndex) {
  const jobIndex = findParentIndex(lines, keyIndex)
  if (jobIndex === undefined) return false

  const jobsIndex = findParentIndex(lines, jobIndex)
  return jobsIndex !== undefined && JOBS_LINE.test(lines[jobsIndex])
}

/**
 * コンテナの参照がダイジェストで固定されていなければ、違反を1件返す。
 *
 * @param {{ lineNumber: number, label: string, reference: string }} image 行番号・報告に使う呼び名・参照
 * @returns {{ lineNumber: number, message: string }[]} 違反（固定されていれば空配列）
 */
function findUndigestedImage({ lineNumber, label, reference }) {
  if (FULL_DIGEST.test(reference)) return []

  return [
    {
      lineNumber,
      message: `${label}が @sha256:<64桁> のダイジェストで固定されていません: ${reference}`
    }
  ]
}

/**
 * 値から、行末コメントと前後の引用符を外した参照を返す。
 *
 * @param {string} rawValue キーの後ろの文字列
 * @returns {string} 参照（例: `actions/checkout@<SHA>`）
 */
function parseReference(rawValue) {
  return rawValue
    .replace(/\s+#.*$/, '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
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
 * 行で見る検査では中を読めない flow 形式（`- { uses: ... }`・`container: { image: ... }`）を探す。
 * 見逃さずに違反にして、ブロック形式への書き直しを求める。
 *
 * @param {string[]} lines ファイルの全行
 * @returns {{ lineNumber: number, message: string }[]} 違反
 */
function findFlowStyleLines(lines) {
  return lines.flatMap((lineText, index) => {
    if (isCommentLine(lineText)) return []

    return FLOW_STYLE_RULES.filter(({ pattern }) => pattern.test(lineText)).map(({ message }) => ({
      lineNumber: index + 1,
      message
    }))
  })
}

/**
 * github-script の step で、値を同じ行に書いた `with:`（`with: { script: ... }`・`with: *anchor`）を探す。
 * `script:` の行を読めないので、見逃さずに違反にして、ブロック形式への書き直しを求める。
 *
 * @param {string[]} lines ファイルの全行
 * @returns {{ lineNumber: number, message: string }[]} 違反
 */
function findInlineGitHubScriptWith(lines) {
  return lines.flatMap((lineText, index) => {
    if (!INLINE_WITH_LINE.test(lineText) || !isGitHubScriptStep(lines, index)) return []

    return [
      {
        lineNumber: index + 1,
        message:
          'github-script の with: は検査できません。ブロック形式（次の行から `script:`）で書いてください'
      }
    ]
  })
}

/**
 * コードとして実行される値（`run:` と、`actions/github-script` の `with: script:`）の中に、
 * 外部入力の式を直接書いた行を探す。式が複数行にまたがっても見つける。
 *
 * @param {string[]} lines ファイルの全行
 * @returns {{ lineNumber: number, message: string }[]} 違反
 */
function findUntrustedExpressionInCode(lines) {
  const violations = []

  for (let index = 0; index < lines.length; index++) {
    const codeValue = collectCodeValueLines(lines, index)
    if (!codeValue) continue

    violations.push(...findUntrustedExpressions(codeValue))
    // 値の中の行（script: の中の `run: ...` で始まる JavaScript など）を、キーとして読み直さない
    index += codeValue.valueLines.length - 1
  }

  return violations
}

/**
 * コードの値の中から、外部入力の式を直接書いた箇所を違反として返す。
 *
 * @param {{ label: string, valueLines: { lineNumber: number, valueText: string }[] }} codeValue
 *   報告に使うキーの呼び名と、値に属する行
 * @returns {{ lineNumber: number, message: string }[]} 違反
 */
function findUntrustedExpressions({ label, valueLines }) {
  const codeText = valueLines.map(({ valueText }) => valueText).join('\n')

  return [...codeText.matchAll(GITHUB_EXPRESSION_PATTERN)]
    .filter(([expression]) => UNTRUSTED_CONTEXT.test(expression))
    .map((match) => ({
      // 式の開始位置の手前にある改行の数が、valueLines の何番目の行かを表す
      lineNumber: valueLines[codeText.slice(0, match.index).split('\n').length - 1].lineNumber,
      message: `${label} に外部入力の式を直接書いています（env: 経由で渡す）: ${match[0]}`
    }))
}

/**
 * 調べる行が、コードとして実行される値のキーなら、その値に属する行を集める。
 *
 * @param {string[]} lines ファイルの全行
 * @param {number} keyIndex 調べる行の添字
 * @returns {{ label: string, valueLines: { lineNumber: number, valueText: string }[] } | undefined}
 *   label は報告に使うキーの呼び名。`keyIndex` の行が `run:` でも github-script の `script:` でもなければ undefined
 */
function collectCodeValueLines(lines, keyIndex) {
  const lineText = lines[keyIndex]
  if (isCommentLine(lineText)) return undefined

  const runMatch = RUN_LINE.exec(lineText)
  if (runMatch) {
    return { label: 'run:', valueLines: collectValueLines(lines, keyIndex, runMatch.groups) }
  }

  const scriptMatch = SCRIPT_LINE.exec(lineText)
  if (scriptMatch && isGitHubScriptInput(lines, keyIndex)) {
    return {
      label: 'github-script の script:',
      valueLines: collectValueLines(lines, keyIndex, scriptMatch.groups)
    }
  }

  return undefined
}

/**
 * `script:` の行が、`actions/github-script` を使う step の `with:` 直下にあるかを返す。
 *
 * @param {string[]} lines ファイルの全行
 * @param {number} scriptIndex `script:` の行の添字
 * @returns {boolean} github-script の入力なら true
 */
function isGitHubScriptInput(lines, scriptIndex) {
  const withIndex = findParentIndex(lines, scriptIndex)
  if (withIndex === undefined || !BLOCK_WITH_LINE.test(lines[withIndex])) return false

  return isGitHubScriptStep(lines, withIndex)
}

/**
 * step のキーの行が、`actions/github-script` を使う step に属するかを返す。
 *
 * @param {string[]} lines ファイルの全行
 * @param {number} stepKeyIndex step のキー（`with:` など）の行の添字
 * @returns {boolean} 同じ step の `uses:` が github-script なら true
 */
function isGitHubScriptStep(lines, stepKeyIndex) {
  return collectSiblingKeyLines(lines, stepKeyIndex).some((lineText) => {
    const match = USES_LINE.exec(lineText)
    return match !== null && GITHUB_SCRIPT_ACTION_PATTERN.test(parseReference(match[1]))
  })
}

/**
 * 調べる行の親キー（上にある、より浅いインデントの最初の行）の添字を返す。
 *
 * @param {string[]} lines ファイルの全行
 * @param {number} childIndex 調べる行の添字
 * @returns {number | undefined} 親キーの行の添字。無ければ undefined
 */
function findParentIndex(lines, childIndex) {
  const childIndent = countIndent(lines[childIndex])

  for (let previousIndex = childIndex - 1; previousIndex >= 0; previousIndex--) {
    if (isBlankOrCommentLine(lines[previousIndex])) continue
    if (countIndent(lines[previousIndex]) < childIndent) return previousIndex
  }

  return undefined
}

/**
 * 調べる行と同じマッピングに並ぶキーの行（step なら `uses:`・`with:` など）を、調べる行も含めて集める。
 * step の先頭の `- uses:` のように、`- ` の分だけ右にキーがある行も含める。
 *
 * @param {string[]} lines ファイルの全行
 * @param {number} keyIndex 調べる行の添字
 * @returns {string[]} 同じマッピングのキーの行
 */
function collectSiblingKeyLines(lines, keyIndex) {
  const keyIndent = findKeyIndent(lines[keyIndex])
  const siblings = [lines[keyIndex]]
  // `- with:` のように調べる行がマッピングの先頭なら、上の行は別のマッピングに属する
  const isFirstKey = keyIndent !== countIndent(lines[keyIndex])
  const linesAbove = isFirstKey ? [] : lines.slice(0, keyIndex).reverse()

  for (const lineText of linesAbove.filter((lineAbove) => !isBlankOrCommentLine(lineAbove))) {
    if (findKeyIndent(lineText) === keyIndent) siblings.push(lineText)
    // より浅い行（step の先頭の `- uses:` を含む）で、このマッピングの上端に着く
    if (countIndent(lineText) < keyIndent) break
  }

  for (const lineText of lines
    .slice(keyIndex + 1)
    .filter((lineBelow) => !isBlankOrCommentLine(lineBelow))) {
    if (countIndent(lineText) < keyIndent) break
    if (countIndent(lineText) === keyIndent) siblings.push(lineText)
  }

  return siblings
}

/**
 * 行のキーが始まる桁を返す。`- uses:` のように `- ` で始まる行は、その分だけ右になる。
 *
 * @param {string} lineText 1行
 * @returns {number} キーが始まる桁
 */
function findKeyIndent(lineText) {
  const [, indent, dash = ''] = /^(\s*)(-\s+)?/.exec(lineText)
  return indent.length + dash.length
}

/**
 * キーの値（1行形式・ブロック形式とも）に属する行を集める。
 *
 * @param {string[]} lines ファイルの全行
 * @param {number} keyIndex キーの行の添字
 * @param {{ indent: string, dash?: string, firstValue: string }} keyGroups キーの行を照合した結果の
 *   名前付きグループ（インデント・`- `・キーと同じ行の値）
 * @returns {{ lineNumber: number, valueText: string }[]} 値に属する行。1つ目はキーと同じ行の
 *   値の部分だけで、2つ目以降は行全体
 */
function collectValueLines(lines, keyIndex, { indent, dash = '', firstValue }) {
  // `- run:` のときキーは「- 」の分だけ右にある。キーより深い行が値に属する
  const keyIndent = indent.length + dash.length
  const valueLines = [{ lineNumber: keyIndex + 1, valueText: firstValue }]

  for (let nextIndex = keyIndex + 1; nextIndex < lines.length; nextIndex++) {
    // 空行は値の途中にありうる。コメントに見える行も、ブロックの値の中では値の一部なので残す
    if (lines[nextIndex].trim() !== '' && countIndent(lines[nextIndex]) <= keyIndent) break
    valueLines.push({ lineNumber: nextIndex + 1, valueText: lines[nextIndex] })
  }

  return valueLines
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
 * YAML の構造（親子・兄弟）をたどるときに読み飛ばす行（空行・コメント行）かを返す。
 *
 * @param {string} lineText 1行
 * @returns {boolean} 読み飛ばす行なら true
 */
function isBlankOrCommentLine(lineText) {
  return lineText.trim() === '' || isCommentLine(lineText)
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
