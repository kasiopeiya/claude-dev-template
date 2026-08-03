#!/usr/bin/env node
// PreToolUse hook: Bashツール実行前に、gh の編集系コマンドが既存の本文を空で上書きする操作を拒否する。
//
// 設計意図（WHY）:
// - GitHub は Issue / PR 本文の版を UI から戻せないため、空で上書きすると復元手段がその場の記憶しかない。
//   取り返しがつかない操作は、実行後に気づく仕組みでは間に合わないので実行前に止める。
//   判定ロジックは emptyGhBodyOverwriteMatcher.mjs に委ね、ここは stdin/stdout の配線と
//   permissionDecision の返却だけを担う。

import { readFileSync } from 'node:fs'

import { detectEmptyGhBodyOverwrite } from './emptyGhBodyOverwriteMatcher.mjs'

function main() {
  // Claude Code の hook 契約（外部仕様）：type: "command" の PreToolUse フックは、
  // イベント情報（tool_input 等）を JSON として子プロセスの標準入力（fd 0）経由で渡す。
  const input = JSON.parse(readFileSync(0, 'utf8'))
  const command = input?.tool_input?.command
  if (!command) return

  const violation = detectEmptyGhBodyOverwrite(command)
  if (!violation) return

  const reason = `既存の本文を空で上書きするため拒否しました（${violation}）。GitHub は本文の版を戻せません。本文を消すのが本当に目的なら人間に依頼し、そうでなければ本文を書いたファイルを --body-file <ファイル> で渡してください。`

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
