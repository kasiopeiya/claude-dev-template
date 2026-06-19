#!/usr/bin/env node
// PreToolUse hook: 編集対象ファイルに適用されるポリシーを「指し示す」だけのローダー。
//
// 設計意図（WHY）:
// - ポリシーの「中身」は一切ここに持たない。本文を変えても hook を直さずに済むようにするため。
// - どのファイルにどのポリシーが効くかは、各ポリシー側の frontmatter `hook.applies-to` が宣言する。
//   このスクリプトはそれを走査してマッチを集めるだけなので、ポリシー追加時もここは変更不要。

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, relative } from 'node:path'

const scriptDir = dirname(fileURLToPath(import.meta.url))
// .claude/hooks/ からプロジェクトルートへ
const projectRoot = resolve(scriptDir, '../..')
const policyDir = resolve(projectRoot, 'docs/policy')

/** glob を行頭〜行末アンカーの正規表現へ変換する。`**` はディレクトリ跨ぎ、`*` は単一階層内。 */
function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') {
          i++
          re += '(?:.*/)?'
        } else {
          re += '.*'
        }
      } else {
        re += '[^/]*'
      }
    } else if ('.+?^${}()|[]\\'.includes(c)) {
      re += '\\' + c
    } else {
      re += c
    }
  }
  return new RegExp('^' + re + '$')
}

/** ポリシーファイルの frontmatter から hook.applies-to のグロブ配列を抜き出す（YAML依存なしの最小実装）。 */
function readAppliesTo(filePath) {
  const text = readFileSync(filePath, 'utf8')
  const match = text.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return []
  // 例: `    applies-to: ["**/*.ts", "**/*.tsx"]`
  const line = match[1].match(/applies-to:\s*\[(.*)\]/)
  if (!line) return []
  return line[1]
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
}

function main() {
  const input = JSON.parse(readFileSync(0, 'utf8'))
  const filePath = input?.tool_input?.file_path
  if (!filePath) return

  const relPath = relative(projectRoot, resolve(filePath))
  // プロジェクト外のファイルは対象外
  if (relPath.startsWith('..')) return

  const matched = []
  for (const name of readdirSync(policyDir)) {
    if (!name.endsWith('.md')) continue
    const globs = readAppliesTo(resolve(policyDir, name))
    if (globs.some((g) => globToRegExp(g).test(relPath))) {
      matched.push(`docs/policy/${name}`)
    }
  }
  if (matched.length === 0) return

  const list = matched.map((p) => `- ${p}`).join('\n')
  const additionalContext = `【ポリシー遵守】編集対象「${relPath}」には以下のポリシーが適用されます。反映前に必ず各ファイルを読み、その指針に沿っているか確認し、違反があれば修正してください:\n${list}`

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext },
    })
  )
}

try {
  main()
} catch {
  // hook は作業をブロックしない。失敗時は何も注入せず黙って抜ける。
  process.exit(0)
}
