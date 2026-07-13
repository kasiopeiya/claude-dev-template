import { type App, type Environment, type Stack } from 'aws-cdk-lib'
import { Template, Match } from 'aws-cdk-lib/assertions'

/**
 * 全環境の Builder に共通する構築・検証ヘルパーを提供する
 */

// 3つの StackBuilder は同一シグネチャなので、テストからまとめて扱うための型
export type StackBuilder = new (app: App, env?: Environment) => { build: () => Stack[] }

/**
 * Builder が返す Stack 配列から AppStack を取り出す
 * （配列順に依存しないよう stackName の接尾辞で特定する）
 */
export function findAppStack(stacks: Stack[]): Stack {
  const appStack = stacks.find((stack) => stack.stackName.endsWith('-app-stack'))
  if (appStack === undefined) throw new Error('AppStack が見つかりません')
  return appStack
}

/**
 * すべての S3 バケットが保管時暗号化されていることを検証する（全環境共通の不変条件）
 */
export function assertAllBucketsEncrypted(template: Template): void {
  template.allResourcesProperties('AWS::S3::Bucket', {
    BucketEncryption: {
      ServerSideEncryptionConfiguration: Match.arrayWith([
        Match.objectLike({
          ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' }
        })
      ])
    }
  })
}
