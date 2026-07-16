import { SNSClient, PublishCommand } from '@aws-sdk/client-sns'
import { type S3Event } from 'aws-lambda'

const snsClient = new SNSClient({})

/**
 * S3 のオブジェクト作成イベントを受け取り、作成されたオブジェクトの情報を SNS へ発行する
 * @param event S3 イベント通知
 */
export const handler = async (event: S3Event): Promise<void> => {
  const topicArn = process.env.TOPIC_ARN
  if (topicArn === undefined) {
    throw new Error('TOPIC_ARN is not set')
  }

  for (const record of event.Records) {
    await snsClient.send(
      new PublishCommand({
        TopicArn: topicArn,
        Message: JSON.stringify({
          bucket: record.s3.bucket.name,
          key: record.s3.object.key
        })
      })
    )
  }
}
