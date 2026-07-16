import { App, type Environment } from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'

import { DevStackBuilder, StgStackBuilder, PrdStackBuilder } from '../stackBuilder'
import { type StackBuilder } from './testHelper'

// snapshot を環境非依存にするため account は undefined で固定する
const env: Environment = { account: undefined, region: 'ap-northeast-1' }

const builders: Record<string, StackBuilder> = {
  dev: DevStackBuilder,
  stg: StgStackBuilder,
  prd: PrdStackBuilder
}

describe.each(Object.entries(builders))('%s', (_env, Builder) => {
  const stacks = new Builder(new App(), env).build()
  for (const stack of stacks) {
    test(stack.stackName, () => {
      expect(Template.fromStack(stack).toJSON()).toMatchSnapshot()
    })
  }
})
