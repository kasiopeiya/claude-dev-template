#!/usr/bin/env node
// PreToolUse hook: Bashツール実行前に、必須ラベルを欠いた `gh issue create` を拒否する。
//
// 設計意図（WHY）:
// - `ai-fixable` / `issue:needs-human-decision` のどちらも付かない Issue は、`/sweep` の一斉対応からも
//   人間の個別相談からも漏れ、誰の目にも触れないまま残る。文章のルールだけでは読み落とせば発火しないので、
//   実行前に機械的に止める。
//   判定ロジックは unlabeledGhIssueCreateMatcher.mjs に委ね、ここは stdin/stdout の配線と
//   permissionDecision の返却だけを担う。

import { readFileSync } from 'node:fs'

import { detectUnlabeledGhIssueCreate } from './unlabeledGhIssueCreateMatcher.mjs'

function main() {
  // Claude Code の hook 契約（外部仕様）：type: "command" の PreToolUse フックは、
  // イベント情報（tool_input 等）を JSON として子プロセスの標準入力（fd 0）経由で渡す。
  const input = JSON.parse(readFileSync(0, 'utf8'))
  const command = input?.tool_input?.command
  if (!command) return

  const violation = detectUnlabeledGhIssueCreate(command)
  if (!violation) return

  const reason = `Issue のラベル指定が不正なため拒否しました（${violation}）。単発の起票は /quick-issue、Plan の分割は /to-issues を使ってください。自分でコマンドを組むなら --label に ai-fixable / issue:needs-human-decision のどちらか一方を必ず含めます（判定基準は .claude/skills/quick-issue/SKILL.md「付与するラベル」）。`

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
