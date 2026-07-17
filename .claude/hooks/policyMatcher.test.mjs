// 責務: policyMatcher の判定ロジックと、全ポリシーの hook 宣言が「沈黙しない」不変条件を検証する。
//
// 実在ファイルには依存しない。hook はパスの実在を確かめず文字列としてマッチするため、
// 入力は合成パスで足りる。実ファイルに紐づけると、リネーム・削除で hook が正しくても
// 無関係にテストが壊れる。

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { globToRegExp, extractFrontmatter, parseAppliesTo } from './policyMatcher.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const policyDir = resolve(scriptDir, '../../docs/policy')

// applies-to を宣言したポリシーが、書式差のせいで1件もパースされない状態を「沈黙」と呼ぶ。
// hook は存在するのに一切発火しない最悪の壊れ方であり、これを機械的に禁じる。
describe('ポリシー宣言の沈黙検知', () => {
  test('applies-to を宣言する全ポリシーは1件以上のグロブにパースされる', () => {
    // Arrange
    const declaringPolicies = readdirSync(policyDir)
      .filter((name) => name.endsWith('.md'))
      .map((name) => ({
        name,
        frontmatter: extractFrontmatter(readFileSync(resolve(policyDir, name), 'utf8'))
      }))
      .filter(({ frontmatter }) => frontmatter !== null && /^\s*applies-to:/m.test(frontmatter))
    const sut = parseAppliesTo

    // Assert
    for (const { name, frontmatter } of declaringPolicies) {
      assert.ok(
        sut(frontmatter).length >= 1,
        `${name}: applies-to を宣言しているのにパース結果が空（hook が沈黙する）`
      )
    }
  })
})

describe('applies-to のパース', () => {
  test('インライン配列・ブロックシーケンス・単一スカラーのどの書式でも同じグロブ配列に読める', () => {
    // Arrange
    const inline = "hook:\n  applies-to: ['app/**/*.ts', 'app/**/*.tsx']"
    const block = "hook:\n  applies-to:\n    - 'app/**/*.ts'\n    - 'app/**/*.tsx'"
    const scalar = "hook:\n  applies-to: '**/*.md'"
    const sut = parseAppliesTo

    // Assert
    assert.deepEqual(sut(inline), ['app/**/*.ts', 'app/**/*.tsx'])
    assert.deepEqual(sut(block), ['app/**/*.ts', 'app/**/*.tsx'])
    assert.deepEqual(sut(scalar), ['**/*.md'])
  })

  test('ダブルクォートや空白のゆらぎがあっても同じグロブに読める', () => {
    const sut = parseAppliesTo

    assert.deepEqual(sut('hook:\n  applies-to: ["**/package.json"]'), ['**/package.json'])
    assert.deepEqual(sut('applies-to:\n  -   "infra/**/*.ts"'), ['infra/**/*.ts'])
  })

  test('applies-to の宣言が無ければ空になる', () => {
    const sut = parseAppliesTo

    assert.deepEqual(sut('name: foo\ndescription: bar'), [])
  })
})

describe('glob から正規表現への変換', () => {
  test('** はディレクトリを跨いでマッチする', () => {
    // Arrange
    const sut = globToRegExp
    const deep = sut('app/**/*.ts')
    const prefixed = sut('**/config.ts')

    // Assert
    assert.ok(deep.test('app/x.ts'))
    assert.ok(deep.test('app/backend/usecase/x.ts'))
    assert.ok(!deep.test('other/x.ts'))
    assert.ok(!deep.test('app/x.tsx'))
    assert.ok(prefixed.test('config.ts'))
    assert.ok(prefixed.test('app/backend/config.ts'))
    assert.ok(!prefixed.test('app/config.ts.bak'))
  })

  test('* は単一階層に留まりディレクトリを跨がない', () => {
    const sut = globToRegExp
    const flat = sut('infra/*.ts')

    assert.ok(flat.test('infra/app.ts'))
    assert.ok(!flat.test('infra/lib/stack.ts'))
  })
})
