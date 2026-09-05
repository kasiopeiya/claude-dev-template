#!/usr/bin/env node
// PreToolUse hook: Bashツール実行前に、禁止した危険コマンドの実行を拒否する。
//
// 設計意図（WHY）:
// - bypass permissions mode では Bash を止められるのは hook だけであり、取り返しのつかない操作は
//   実行前に止めるしかない。Bash に掛ける hook はこの1本に統合してある——hook は1本ごとに
//   node の起動コストが全 Bash 実行に乗るため、禁止を増やすときは hook ではなくルール表を増やす。
// - 判定ロジックは forbiddenCommandMatcher.mjs に委ね、ここは stdin/stdout の配線と
//   permissionDecision の返却だけを担う。

import { readFileSync } from 'node:fs'

import { detectForbiddenCommand } from './forbiddenCommandMatcher.mjs'

function main() {
  // Claude Code の hook 契約（外部仕様）：type: "command" の PreToolUse フックは、
  // イベント情報（tool_input 等）を JSON として子プロセスの標準入力（fd 0）経由で渡す。
  const input = JSON.parse(readFileSync(0, 'utf8'))
  const command = input?.tool_input?.command
  if (!command) return

  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? input?.cwd ?? process.cwd()
  const violation = detectForbiddenCommand(command, { projectDir })
  if (!violation) return

  const reason = `禁止コマンドのため拒否しました（${violation}）。実行が必要な場合は人間に依頼してください。`

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
