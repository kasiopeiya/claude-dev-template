// 責務: shouldRemindStaticCheck の判定ロジックを合成入力だけで検証する。
//
// 実在ファイルには依存しない。hook はパスの実在を確かめず文字列としてマッチするため、
// 入力は合成パスで足りる。実ファイルに紐づけると、リネーム・削除で hook が正しくても
// 無関係にテストが壊れる。

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { shouldRemindStaticCheck } from './staticCheckMatcher.mjs'

describe('shouldRemindStaticCheck', () => {
  test('app/・infra/ 配下の TypeScript は対象（true）', () => {
    assert.equal(shouldRemindStaticCheck('app/backend/src/domain/user.ts'), true)
    assert.equal(shouldRemindStaticCheck('app/frontend/src/App.tsx'), true)
    assert.equal(shouldRemindStaticCheck('infra/lib/stack.ts'), true)
  })

  test('スコープ外ディレクトリは対象外（false）', () => {
    assert.equal(shouldRemindStaticCheck('docs/design/app.md'), false)
    assert.equal(shouldRemindStaticCheck('eslint-rules/awsCdkLibBarrelImport.mjs'), false)
    assert.equal(shouldRemindStaticCheck('scripts/generate-adr-index.mjs'), false)
  })

  test('スコープ内でも TypeScript でなければ対象外（false）', () => {
    assert.equal(shouldRemindStaticCheck('app/backend/README.md'), false)
    assert.equal(shouldRemindStaticCheck('infra/cdk.json'), false)
  })

  test('型定義・依存・生成物は対象外（false）', () => {
    assert.equal(shouldRemindStaticCheck('app/backend/src/types.d.ts'), false)
    assert.equal(shouldRemindStaticCheck('app/backend/node_modules/pkg/index.ts'), false)
  })

  test('Windows 区切りでも判定できる', () => {
    assert.equal(shouldRemindStaticCheck('app\\backend\\src\\user.ts'), true)
  })

  test('不正・空入力は対象外（false）', () => {
    assert.equal(shouldRemindStaticCheck(''), false)
    assert.equal(shouldRemindStaticCheck(undefined), false)
    assert.equal(shouldRemindStaticCheck(null), false)
  })
})
