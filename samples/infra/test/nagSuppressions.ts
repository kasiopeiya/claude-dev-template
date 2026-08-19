// cdk-nag抑制ルール
export const nagSuppressions = [
  { id: 'AwsSolutions-IAM4', reason: 'can use managed policy' },
  { id: 'AwsSolutions-IAM5', reason: 'can use wildcard policy' },
  { id: 'AwsSolutions-S1', reason: 'No need for server access logs' }
]
