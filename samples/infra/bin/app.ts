#!/usr/bin/env node
import { App, Aspects, Stack } from 'aws-cdk-lib'
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag'

import { DevStackBuilder, StgStackBuilder, PrdStackBuilder } from '../stackBuilder'
import { nagSuppressions } from '../test/nagSuppressions'

const app = new App()

new DevStackBuilder(app).build()
new StgStackBuilder(app).build()
new PrdStackBuilder(app).build()

cdkNagSecurityCheck()

/**
 * cdk-nagによるセキュリティチェックを全Stackに適用し、既知の抑制ルールを設定する。
 */
function cdkNagSecurityCheck(): void {
  Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }))
  for (const node of app.node.children) {
    if (Stack.isStack(node)) {
      NagSuppressions.addStackSuppressions(node, nagSuppressions)
    }
  }
}
