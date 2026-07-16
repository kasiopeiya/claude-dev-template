// 責務: 編集対象パスにどのポリシーが適用されるかの判定（frontmatter の applies-to パースと glob マッチ）のみを担う。
//
// 設計意図（WHY）:
// - ポリシーの「中身」は一切持たない。どのファイルにどのポリシーが効くかは各ポリシー側の
//   frontmatter `hook.applies-to` が宣言し、ここはそれを走査してマッチを集めるだけ。
// - 入出力（stdin/stdout）を持つ policy-loader.mjs から判定ロジックを分離してある。
//   判定は入出力と別の関心事であり、分離することで hook を起動せずに単体検証できる。

import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

/** glob を行頭〜行末アンカーの正規表現へ変換する。`**` はディレクトリ跨ぎ、`*` は単一階層内。 */
export function globToRegExp(glob) {
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

/** frontmatter（`---` に挟まれた内側）を取り出す。無ければ null。 */
export function extractFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---/)
  return match ? match[1] : null
}

/**
 * frontmatter テキストから `applies-to` のグロブ配列を抜き出す（YAML依存なしの最小実装）。
 * インライン配列・ブロックシーケンス・単一スカラーの3形式に対応する。
 * `hook:` が書かれているのに1件も返せない「沈黙」を防ぐため、書式差を吸収する。
 */
export function parseAppliesTo(frontmatter) {
  const lines = frontmatter.split('\n')
  const idx = lines.findIndex((l) => /^\s*applies-to:/.test(l))
  if (idx === -1) return []

  const value = lines[idx].replace(/^\s*applies-to:\s*/, '').trim()

  // インライン配列: applies-to: ['a', 'b']
  if (value.startsWith('[')) {
    return splitInline(value.replace(/^\[|\]$/g, ''))
  }
  // インライン単一スカラー: applies-to: '**/*.md'
  if (value) return [stripQuotes(value)]

  // ブロックシーケンス: 後続の `- item` 行を、リスト項目でない行に当たるまで集める
  const items = []
  for (let i = idx + 1; i < lines.length; i++) {
    const item = lines[i].match(/^\s*-\s*(.+?)\s*$/)
    if (!item) break
    items.push(stripQuotes(item[1]))
  }
  return items
}

function splitInline(inner) {
  return inner
    .split(',')
    .map((s) => stripQuotes(s.trim()))
    .filter(Boolean)
}

function stripQuotes(s) {
  return s.replace(/^["']|["']$/g, '')
}

/** ポリシーファイルの frontmatter から applies-to のグロブ配列を返す。frontmatter が無ければ []。 */
export function readAppliesTo(filePath) {
  const frontmatter = extractFrontmatter(readFileSync(filePath, 'utf8'))
  return frontmatter ? parseAppliesTo(frontmatter) : []
}

/** policyDir 内の *.md を走査し、relPath にマッチするポリシーのファイル名配列を返す。 */
export function collectMatchingPolicies(relPath, policyDir) {
  const matched = []
  for (const name of readdirSync(policyDir)) {
    if (!name.endsWith('.md')) continue
    const globs = readAppliesTo(resolve(policyDir, name))
    if (globs.some((g) => globToRegExp(g).test(relPath))) {
      matched.push(name)
    }
  }
  return matched
}
