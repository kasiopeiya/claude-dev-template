#!/usr/bin/env node
// PreToolUse hook: 編集対象ファイルに適用されるポリシーと Rule を「指し示す」だけのローダー。
//
// 設計意図（WHY）:
// - このファイルは stdin/stdout の入出力だけを担う。どのポリシー・Rule が効くかの判定は
//   policyMatcher.mjs / ruleMatcher.mjs に委ね、中身はここに一切持たない。
// - Rule の指し示しには2つの経路がある。
//   1. `paths`：対象ファイルが存在しないときだけ指す。既存ファイルは Edit・Write の前に Read
//      しており標準ロードが既に効いているため、二重に指さない。
//   2. `hook.applies-to`：Policy と同じく、対象ファイルの有無にかかわらず常に指す。名指しの
//      パス（docs/policy/**・docs/ 直下のハブ）を `paths` に書くとハブや他ポリシーにも掛かって
//      しまうため、編集時にだけ注入するこの経路を使う（policy-driven-development-policy）。
//   同じ Rule が両方にマッチしても一覧に一度だけ出す。
// - Rule の探索に失敗しても、ポリシーの指し示しは道連れで止めない（下記 collectRuleNames）。

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, isAbsolute, resolve, relative, sep } from 'node:path'

import { collectMatchingPolicies } from './policyMatcher.mjs'
import { collectMatchingRules, collectRulesByAppliesTo } from './ruleMatcher.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
// .claude/hooks/ からプロジェクトルートへ
const projectRoot = resolve(scriptDir, '../..')
const policyDir = resolve(projectRoot, 'docs/policy')
const rulesDir = resolve(projectRoot, '.claude/rules')

/**
 * OS の区切り文字で書かれたパスを `/` 区切りにする。
 *
 * @param {string} nativePath node:path が返したパス
 * @returns {string} `/` 区切りのパス
 */
function toSlashSeparatedPath(nativePath) {
  return nativePath.split(sep).join('/')
}

/**
 * 適用される Rule のファイル名一覧を、重複なしで返す。
 *
 * Rule の探索に失敗しても []。ここで投げると main() 全体が catch に抜け、
 * 既に見つかっているポリシーの指し示しまで道連れで失われるため。
 */
function collectRuleNames(targetAbsolutePath, targetRelativePath) {
  try {
    const matchedByAppliesTo = collectRulesByAppliesTo(targetRelativePath, rulesDir)
    const matchedByPaths = existsSync(targetAbsolutePath)
      ? []
      : collectMatchingRules(targetRelativePath, rulesDir)
    return [...new Set([...matchedByAppliesTo, ...matchedByPaths])]
  } catch {
    return []
  }
}

function main() {
  // Claude Code の hook 契約（外部仕様）：type: "command" の PreToolUse フックは、
  // イベント情報（tool_input 等）を JSON として子プロセスの標準入力（fd 0）経由で渡す。
  const hookInput = JSON.parse(readFileSync(0, 'utf8'))
  const targetFilePath = hookInput?.tool_input?.file_path
  if (!targetFilePath) return

  const targetAbsolutePath = resolve(targetFilePath)
  const nativeRelativePath = relative(projectRoot, targetAbsolutePath)
  // 別ドライブ（Windows）だと relative は相対パスにならず、絶対パスをそのまま返す
  const isOutsideProject = nativeRelativePath.startsWith('..') || isAbsolute(nativeRelativePath)
  if (isOutsideProject) return
  // applies-to・paths の glob は `/` 区切りで書かれている。Windows の `\` 区切りのままだと1件も当たらない
  const targetRelativePath = toSlashSeparatedPath(nativeRelativePath)

  const matchedPolicyPaths = collectMatchingPolicies(targetRelativePath, policyDir).map(
    (name) => `docs/policy/${name}`
  )
  const matchedRulePaths = collectRuleNames(targetAbsolutePath, targetRelativePath).map(
    (name) => `${toSlashSeparatedPath(relative(projectRoot, rulesDir))}/${name}`
  )

  const appliedDocumentPaths = [...matchedPolicyPaths, ...matchedRulePaths]
  if (appliedDocumentPaths.length === 0) return

  const appliedDocumentBulletList = appliedDocumentPaths
    .map((documentPath) => `- ${documentPath}`)
    .join('\n')
  const additionalContext = `【ポリシー遵守】編集対象「${targetRelativePath}」には以下のポリシー・ルールが適用されます。反映前に必ず各ファイルを読み、その指針に沿っているか確認し、違反があれば修正してください:\n${appliedDocumentBulletList}`

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext }
    })
  )
}

try {
  main()
} catch {
  // hook は作業をブロックしない。失敗時は何も注入せず黙って抜ける。
  process.exit(0)
}
