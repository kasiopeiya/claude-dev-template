import * as path from 'path'

import { RemovalPolicy, Duration } from 'aws-cdk-lib'
import { aws_s3 as s3 } from 'aws-cdk-lib'
import { aws_s3_notifications as s3n } from 'aws-cdk-lib'
import { aws_lambda as lambda } from 'aws-cdk-lib'
import { aws_lambda_nodejs as nodejs } from 'aws-cdk-lib'
import { aws_sns as sns } from 'aws-cdk-lib'
import { Construct } from 'constructs'

interface EventNotificationS3BucketProps extends s3.BucketProps {
  // Lambda に publish 権限を付与し、ARN を環境変数へ渡すため ITopic を要求する
  readonly topic: sns.ITopic
}

/**
 * オブジェクト作成を Lambda で受けて SNS へ通知する S3 バケットを構築する
 */
export class EventNotificationS3Bucket extends Construct {
  public readonly bucket: s3.IBucketRef

  // addAlarms など下流でメトリクスを参照するため IFunction を公開する
  public readonly func: lambda.IFunction

  constructor(scope: Construct, id: string, props: EventNotificationS3BucketProps) {
    super(scope, id)

    /*
    * Lambda
    -------------------------------------------------------------------------- */
    const eventNotificationHandlerFunc = new nodejs.NodejsFunction(this, 'Function', {
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(10),
      entry: path.join(__dirname, '../lambda/eventNotification/index.ts'),
      handler: 'handler',
      environment: {
        TOPIC_ARN: props.topic.topicArn
      },
      bundling: {
        // @aws-sdk/* は Lambda ランタイム(Node.js 24)が v3 を提供するためバンドルに含めない
        externalModules: ['@aws-sdk/*']
      }
    })
    props.topic.grantPublish(eventNotificationHandlerFunc)
    this.func = eventNotificationHandlerFunc

    /*
    * S3 Bucket
    -------------------------------------------------------------------------- */
    const bucket = new s3.Bucket(this, 'Bucket', {
      ...props,
      autoDeleteObjects: props.autoDeleteObjects ?? true,
      removalPolicy: props.removalPolicy ?? RemovalPolicy.DESTROY,
      encryption: props.encryption ?? s3.BucketEncryption.S3_MANAGED,
      enforceSSL: props.enforceSSL ?? true
    })
    bucket.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.LambdaDestination(eventNotificationHandlerFunc))
    this.bucket = bucket
  }
}
