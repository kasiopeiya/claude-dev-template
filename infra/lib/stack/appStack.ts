import { Stack, Duration, type StackProps } from 'aws-cdk-lib'
import { aws_cloudwatch as cloudwatch } from 'aws-cdk-lib'
import { aws_cloudwatch_actions as cloudwatchActions } from 'aws-cdk-lib'
import { aws_sns as sns } from 'aws-cdk-lib'
import { type Construct } from 'constructs'

import { EventNotificationS3Bucket } from '../construct/eventNotificationS3'

interface AppStackProps extends StackProps {
  // grantPublish とアラームアクションの通知先に使うため ITopic を要求する
  readonly topic: sns.ITopic
}

/**
 * メインアプリのスタック
 * ステートレスなものを中心に構築する
 */
export class AppStack extends Stack {
  private readonly topic: sns.ITopic

  private readonly eventNotificationBucket: EventNotificationS3Bucket

  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props)
    this.topic = props.topic

    /*
    * イベント通知機能付きのS3バケット
    -------------------------------------------------------------------------- */
    this.eventNotificationBucket = new EventNotificationS3Bucket(
      this,
      'EventNotificationS3Bucket',
      {
        topic: props.topic
      }
    )
  }

  /**
   * 監視アラーム（Lambda のエラー検知）を追加する。本番のみ有効化する想定。
   * 環境による「振る舞いの差分」は Stack 内の分岐ではなく public メソッドで表現し、
   * Builder 層から呼び分ける（cdk-design-policy「環境差分は Stack 内で分岐させない」）
   */
  public addAlarms(): void {
    const errorAlarm = new cloudwatch.Alarm(this, 'FunctionErrorsAlarm', {
      metric: this.eventNotificationBucket.func.metricErrors({ period: Duration.minutes(1) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
    })
    errorAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.topic))
  }
}
