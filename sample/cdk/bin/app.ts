#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib'
// import { Aspects, Stack } from 'aws-cdk-lib'
// import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag'

import { DevStackBuilder, PrdStackBuilder } from '../stackBuilder'
// import { nagSuppressions } from '../test/nagSuppressions'

const app = new cdk.App()

new DevStackBuilder(app)
new PrdStackBuilder(app)

// CDK Nagのルールを適用
// Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }))
// for (const node of app.node.children) {
//   if (Stack.isStack(node)) {
//     NagSuppressions.addStackSuppressions(node, nagSuppressions)
//   }
// }
