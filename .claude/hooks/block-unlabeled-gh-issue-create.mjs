#!/usr/bin/env node
// PreToolUse hook: Bashツール実行前に、必須ラベルを欠いた `gh issue create` を拒否する。
//
// 設計意図（WHY）:
// - `ai-fixable` / `issue:needs-human-decision` のどちらも付かない Issue は、`/sweep` の一斉対応からも
//   人間の個別相談からも漏れ、誰の目にも触れないまま残る。文章のルールだけでは読み落とせば発火しないので、
//   実行前に機械的に止める。
// - 拒否文で手組みの通し方（--label の付け方）を案内しないのは、ラベルが揃っても Skill の本文テンプレート
//   （タスク一覧・実装フロー）が揃わないため。実装フロー欄が無い Issue は「issue 番号だけで開発フローを
//   追従する」運用が成り立たない。検査自体はラベルに留める（本文の妥当性は決定論的に判定できない）。
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

  const reason = `Issue のラベル指定が不正なため拒否しました（${violation}）。起票は Skill を通してください——単発の起票は /quick-issue、Plan の分割は /to-issues。ラベルだけでなく「タスク一覧」「実装フロー（使用するSkill）」まで揃うのは Skill を通した場合だけです。`

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
