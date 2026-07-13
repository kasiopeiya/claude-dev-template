// 責務: CDK コードにおける aws-cdk-lib の正しい barrel import 形式の例を示す
// 注: 型解決は不要なため aws-cdk-lib / constructs は未インストール（本サンプルは型情報なし lint）

import { Stack, StackProps, RemovalPolicy } from 'aws-cdk-lib'
import { aws_s3 as s3 } from 'aws-cdk-lib'
import { Construct } from 'constructs'

export class SampleBucketStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props)

    new s3.Bucket(this, 'SampleBucket', {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true
    })
  }
}
