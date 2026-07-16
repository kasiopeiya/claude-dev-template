#!/usr/bin/env node
// PreToolUse hook: 編集対象ファイルに適用されるポリシーを「指し示す」だけのローダー。
//
// 設計意図（WHY）:
// - このファイルは stdin/stdout の入出力だけを担う。どのポリシーが効くかの判定は
//   policyMatcher.mjs に委ね、ポリシーの「中身」もここには一切持たない。
//   本文を変えても、ポリシーを増やしても、このファイルは変更不要。

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, relative } from 'node:path'

import { collectMatchingPolicies } from './policyMatcher.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
// .claude/hooks/ からプロジェクトルートへ
const projectRoot = resolve(scriptDir, '../..')
const policyDir = resolve(projectRoot, 'docs/policy')

function main() {
  const input = JSON.parse(readFileSync(0, 'utf8'))
  const filePath = input?.tool_input?.file_path
  if (!filePath) return

  const relPath = relative(projectRoot, resolve(filePath))
  // プロジェクト外のファイルは対象外
  if (relPath.startsWith('..')) return

  const matched = collectMatchingPolicies(relPath, policyDir)
  if (matched.length === 0) return

  const list = matched.map((name) => `- docs/policy/${name}`).join('\n')
  const additionalContext = `【ポリシー遵守】編集対象「${relPath}」には以下のポリシーが適用されます。反映前に必ず各ファイルを読み、その指針に沿っているか確認し、違反があれば修正してください:\n${list}`

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
