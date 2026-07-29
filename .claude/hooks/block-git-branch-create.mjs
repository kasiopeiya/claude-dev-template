#!/usr/bin/env node
// PreToolUse hook: Bashツール実行前に、AIが自律的にgitブランチを新規作成する操作を拒否する。
//
// 設計意図（WHY）:
// - ブランチ運用は人間が把握・判断すべき事項であり、AIが勝手にbranchを作成すると
//   人間の把握しないブランチが増える。判定ロジックは gitBranchCreationMatcher.mjs に委ね、
//   ここは stdin/stdout の配線と permissionDecision の返却だけを担う。

import { readFileSync } from 'node:fs'

import { detectGitBranchCreation } from './gitBranchCreationMatcher.mjs'

function main() {
  // Claude Code の hook 契約（外部仕様）：type: "command" の PreToolUse フックは、
  // イベント情報（tool_input 等）を JSON として子プロセスの標準入力（fd 0）経由で渡す。
  const input = JSON.parse(readFileSync(0, 'utf8'))
  const command = input?.tool_input?.command
  if (!command) return

  const violation = detectGitBranchCreation(command)
  if (!violation) return

  const reason = `AIによるgitブランチの新規作成はポリシーで禁止されています（${violation}）。ブランチ作成が必要な場合は人間に依頼してください。`

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason
      }
    })
  )
}

try {
  main()
} catch {
  // 判定できないときはブロックしない（fail-open）。
  process.exit(0)
}
