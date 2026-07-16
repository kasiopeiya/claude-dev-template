import { App, type Environment } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'

import { DevStackBuilder, StgStackBuilder, PrdStackBuilder } from '../stackBuilder'
import { type StackBuilder, findAppStack, assertAllBucketsEncrypted } from './testHelper'

const env: Environment = { account: undefined, region: 'ap-northeast-1' }

const appTemplateOf = (Builder: StackBuilder): Template =>
  Template.fromStack(findAppStack(new Builder(new App(), env).build()))

// 全環境で成り立つべき不変条件
describe.each<[string, StackBuilder]>([
  ['dev', DevStackBuilder],
  ['stg', StgStackBuilder],
  ['prd', PrdStackBuilder]
])('%s 共通', (_env, Builder) => {
  test('S3バケットが保管時暗号化されている', () => {
    assertAllBucketsEncrypted(appTemplateOf(Builder))
  })
})

// 環境差分：本番のみ Builder が addAlarms を呼ぶ（appStack.ts の設計方針）
describe('環境差分：Lambda エラー検知アラーム', () => {
  test('本番はアラームを持つ', () => {
    appTemplateOf(PrdStackBuilder).resourceCountIs('AWS::CloudWatch::Alarm', 1)
  })

  test.each<[string, StackBuilder]>([
    ['dev', DevStackBuilder],
    ['stg', StgStackBuilder]
  ])('%s はアラームを持たない', (_env, Builder) => {
    appTemplateOf(Builder).resourceCountIs('AWS::CloudWatch::Alarm', 0)
  })
})
