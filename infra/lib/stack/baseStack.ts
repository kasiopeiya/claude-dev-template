import { Stack, type StackProps } from 'aws-cdk-lib'
import { aws_kms as kms } from 'aws-cdk-lib'
import { aws_sns as sns } from 'aws-cdk-lib'
import { type Construct } from 'constructs'

/**
 * ステートフルなリソースや共通リソースを構築する
 * ステートフルリソースは基本的に削除してはならないものであるため、スタックを分離する
 */
export class BaseStack extends Stack {
  // 下流(AppStack)で grantPublish・SnsAction など L2 操作が必要なため ITopic を公開する
  public readonly topic: sns.ITopic

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props)

    this.topic = new sns.Topic(this, 'Topic', {
      displayName: `${this.stackName}-topic`,
      // SSE(AWS管理キー)で保管時暗号化し、HTTPS 以外の publish を拒否する
      masterKey: kms.Alias.fromAliasName(this, 'SnsManagedKey', 'alias/aws/sns'),
      enforceSSL: true
    })
  }
}
