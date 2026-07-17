import { App } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'

import { DevStackBuilder, StgStackBuilder, PrdStackBuilder } from '../stackBuilder'
import { devParameter, stgParameter, prdParameter, type Parameter } from '../parameter'
import { type StackBuilder, withFixedEnv } from './testHelper'

const cases: [string, StackBuilder, Parameter][] = [
  ['dev', DevStackBuilder, devParameter],
  ['stg', StgStackBuilder, stgParameter],
  ['prd', PrdStackBuilder, prdParameter]
]

describe.each(cases)('%s 環境', (_env, Builder, param) => {
  const stacks = new Builder(new App(), withFixedEnv(param)).build()
  for (const stack of stacks) {
    test(`${stack.stackName} のテンプレートがスナップショットと一致する`, () => {
      const sut = Template.fromStack(stack)

      expect(sut.toJSON()).toMatchSnapshot()
    })
  }
})
