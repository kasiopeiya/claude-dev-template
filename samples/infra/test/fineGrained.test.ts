import { App } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'

import { DevStackBuilder, StgStackBuilder, PrdStackBuilder } from '../stackBuilder'
import { devParameter, stgParameter, prdParameter, type Parameter } from '../parameter'
import {
  type StackBuilder,
  findAppStack,
  assertAllBucketsEncrypted,
  withFixedEnv
} from './testHelper'

const appTemplateOf = (Builder: StackBuilder, param: Parameter): Template =>
  Template.fromStack(findAppStack(new Builder(new App(), withFixedEnv(param)).build()))

// 全環境で成り立つべき不変条件
describe.each<[string, StackBuilder, Parameter]>([
  ['dev', DevStackBuilder, devParameter],
  ['stg', StgStackBuilder, stgParameter],
  ['prd', PrdStackBuilder, prdParameter]
])('%s 環境の共通不変条件', (_env, Builder, param) => {
  test('S3バケットが保管時暗号化されている', () => {
    const sut = appTemplateOf(Builder, param)

    assertAllBucketsEncrypted(sut)
  })
})

// 環境差分：本番のみ Builder が addAlarms を呼ぶ（appStack.ts の設計方針）
describe('環境差分：Lambda エラー検知アラーム', () => {
  test('本番はアラームを持つ', () => {
    const sut = appTemplateOf(PrdStackBuilder, prdParameter)

    sut.resourceCountIs('AWS::CloudWatch::Alarm', 1)
  })

  test.each<[string, StackBuilder, Parameter]>([
    ['dev', DevStackBuilder, devParameter],
    ['stg', StgStackBuilder, stgParameter]
  ])('%s はアラームを持たない', (_env, Builder, param) => {
    const sut = appTemplateOf(Builder, param)

    sut.resourceCountIs('AWS::CloudWatch::Alarm', 0)
  })
})
