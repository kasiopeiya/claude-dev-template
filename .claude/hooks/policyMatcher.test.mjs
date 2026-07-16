// 責務: policyMatcher の判定ロジックと、全ポリシーの hook 宣言が「沈黙しない」不変条件を検証する。
//
// 実在ファイルには依存しない。hook はパスの実在を確かめず文字列としてマッチするため、
// 入力は合成パスで足りる。実ファイルに紐づけると、リネーム・削除で hook が正しくても
// 無関係にテストが壊れる。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { globToRegExp, extractFrontmatter, parseAppliesTo } from './policyMatcher.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const policyDir = resolve(scriptDir, '../../docs/policy')

// ── 沈黙の検知（本丸・パス非依存）──────────────────────────
// applies-to を宣言したポリシーが、書式差のせいで1件もパースされない状態を「沈黙」と呼ぶ。
// hook は存在するのに一切発火しない最悪の壊れ方であり、これを機械的に禁じる。
test('applies-to を宣言する全ポリシーは1件以上のグロブにパースされる（沈黙禁止）', () => {
  for (const name of readdirSync(policyDir)) {
    if (!name.endsWith('.md')) continue
    const frontmatter = extractFrontmatter(readFileSync(resolve(policyDir, name), 'utf8'))
    if (!frontmatter || !/^\s*applies-to:/m.test(frontmatter)) continue

    const globs = parseAppliesTo(frontmatter)
    assert.ok(
      globs.length >= 1,
      `${name}: applies-to を宣言しているのにパース結果が空（hook が沈黙する）`
    )
  }
})

// ── パーサ両形式（合成入力）────────────────────────────────
test('parseAppliesTo はインライン配列・ブロックシーケンス・単一スカラーを同じ結果に読む', () => {
  const inline = "hook:\n  applies-to: ['app/**/*.ts', 'app/**/*.tsx']"
  const block = "hook:\n  applies-to:\n    - 'app/**/*.ts'\n    - 'app/**/*.tsx'"
  const expected = ['app/**/*.ts', 'app/**/*.tsx']

  assert.deepEqual(parseAppliesTo(inline), expected)
  assert.deepEqual(parseAppliesTo(block), expected)
  assert.deepEqual(parseAppliesTo("hook:\n  applies-to: '**/*.md'"), ['**/*.md'])
})

test('parseAppliesTo はダブルクォートと空白ゆらぎを吸収する', () => {
  assert.deepEqual(parseAppliesTo('hook:\n  applies-to: ["**/package.json"]'), ['**/package.json'])
  assert.deepEqual(parseAppliesTo('applies-to:\n  -   "infra/**/*.ts"'), ['infra/**/*.ts'])
})

test('parseAppliesTo は applies-to が無ければ空を返す', () => {
  assert.deepEqual(parseAppliesTo('name: foo\ndescription: bar'), [])
})

// ── glob 意味論（合成パス）────────────────────────────────
test('globToRegExp: ** はディレクトリ跨ぎ、* は単一階層に留まる', () => {
  const appTs = globToRegExp('app/**/*.ts')
  assert.ok(appTs.test('app/x.ts'))
  assert.ok(appTs.test('app/backend/usecase/x.ts'))
  assert.ok(!appTs.test('other/x.ts'))
  assert.ok(!appTs.test('app/x.tsx'))

  const single = globToRegExp('**/config.ts')
  assert.ok(single.test('config.ts'))
  assert.ok(single.test('app/backend/config.ts'))
  assert.ok(!single.test('app/config.ts.bak'))

  // * は / を跨がない
  const flat = globToRegExp('infra/*.ts')
  assert.ok(flat.test('infra/app.ts'))
  assert.ok(!flat.test('infra/lib/stack.ts'))
})
