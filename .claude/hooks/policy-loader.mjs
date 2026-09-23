#!/usr/bin/env node
// PreToolUse hook: 編集対象ファイルに適用されるポリシーと Rule を「指し示す」だけのローダー。
//
// 設計意図（WHY）:
// - このファイルは stdin/stdout の入出力だけを担う。どのポリシー・Rule が効くかの判定は
//   policyMatcher.mjs / ruleMatcher.mjs に委ね、中身はここに一切持たない。
// - Rule は対象ファイルが存在しないときだけ指す。既存ファイルは Edit・Write の前に Read して
//   おり標準ロードが既に効いているため、二重に指さない（policy-driven-development-policy）。
// - Rule の探索に失敗しても、ポリシーの指し示しは道連れで止めない（下記 collectRulePaths）。

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, relative } from 'node:path'

import { collectMatchingPolicies } from './policyMatcher.mjs'
import { collectMatchingRules } from './ruleMatcher.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
// .claude/hooks/ からプロジェクトルートへ
const projectRoot = resolve(scriptDir, '../..')
const policyDir = resolve(projectRoot, 'docs/policy')
const rulesDir = resolve(projectRoot, '.claude/rules')

/**
 * 対象ファイルが存在しないときだけ、paths の合う Rule のパス一覧を返す。
 *
 * Rule の探索に失敗しても []。ここで投げると main() 全体が catch に抜け、
 * 既に見つかっているポリシーの指し示しまで道連れで失われるため。
 */
function collectRulePaths(targetAbsolutePath, targetRelativePath) {
  if (existsSync(targetAbsolutePath)) return []
  try {
    return collectMatchingRules(targetRelativePath, rulesDir).map(
      (name) => `${relative(projectRoot, rulesDir)}/${name}`
    )
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
  const targetRelativePath = relative(projectRoot, targetAbsolutePath)
  const isOutsideProject = targetRelativePath.startsWith('..')
  if (isOutsideProject) return

  const matchedPolicyPaths = collectMatchingPolicies(targetRelativePath, policyDir).map(
    (name) => `docs/policy/${name}`
  )
  const matchedRulePaths = collectRulePaths(targetAbsolutePath, targetRelativePath)

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
