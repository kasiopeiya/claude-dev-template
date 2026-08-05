#!/usr/bin/env node
// PostToolUse hook: CLAUDE.md へ書き込んだ直後に文字数上限を検査し、超えていたら AI へ差し戻す。
//
// 設計意図（WHY）:
// - CLAUDE.md は毎セッション全文が読まれるため、書いた分だけ恒久的にコンテキストを食う。
//   上限（docs/policy/policy-driven-development-policy.md）を文章で書くだけでは、読み落としと
//   自己弁護で守られない。決定論的に判定できるので機械に落とさせる（Issue #247）。
// - PreToolUse ではなく PostToolUse に置く。書き込む前は編集後の全文が分からず、超過を判定できない。
// - hook が効くのは Claude Code 経由の編集だけ。人間のエディタ編集は CI（npm run check:claude-md）が
//   捕まえる。判定ロジックは scripts/check-claude-md-size.mjs の1ヶ所にしか置かない。

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { basename, dirname, resolve } from 'node:path'

import {
  measureClaudeMd,
  CHARACTER_LIMIT,
  formatViolations
} from '../../scripts/check-claude-md-size.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
// .claude/hooks/ からプロジェクトルートへ
const projectRoot = resolve(scriptDir, '../..')

function main() {
  // Claude Code の hook 契約（外部仕様）：PostToolUse はイベント情報を JSON として
  // 子プロセスの標準入力（fd 0）経由で渡す。tool_input.file_path が書き込み先。
  const input = JSON.parse(readFileSync(0, 'utf8'))

  const filePath = input?.tool_input?.file_path
  if (!filePath || basename(filePath) !== 'CLAUDE.md') return

  const absolutePath = resolve(projectRoot, filePath)
  // リポジトリ外の CLAUDE.md（~/.claude/CLAUDE.md 等）は他プロジェクトと共有されるため対象外
  if (!absolutePath.startsWith(projectRoot)) return

  const { total, breakdown } = measureClaudeMd(absolutePath)
  if (total <= CHARACTER_LIMIT) return

  // PostToolUse の契約：decision: "block" にすると reason がモデルに渡り、対処を促す。
  process.stdout.write(
    JSON.stringify({
      decision: 'block',
      reason: formatViolations([{ path: filePath, total, breakdown }])
    })
  )
}

try {
  main()
} catch {
  // 判定できないときは作業をブロックしない（fail-open）。
  process.exit(0)
}
