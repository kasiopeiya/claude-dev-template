/**
 * 環境別パラメータ設定
 * 環境固有の値をコードから分離し、一元管理する
 * 環境ごとに異なる値や外部インポートリソースはこのファイルを見ればすべてわかるようにする
 */

import { type Environment } from 'aws-cdk-lib'
import { aws_ec2 as ec2 } from 'aws-cdk-lib'

// デプロイ先環境は複数であるがアカウントID設定は１つのみ
// そのときにデプロイしたい環境のアカウントIDをセットすること
const env: Environment = {
  account: process.env.ACCOUNT_ID,
  region: 'ap-northeast-1'
}

export interface Parameter {
  env: Environment
  prefix: string
  vpcId: string
  instanceType: ec2.InstanceType
}

export const devParameter: Parameter = {
  env,
  prefix: 'kasio-dev',
  // VPCは手動作成リソース
  vpcId: 'aaaaaaaaaa',
  // EC2インスタンスタイプは環境によって異なるためここで設定
  instanceType: ec2.InstanceType.of(ec2.InstanceClass.T2, ec2.InstanceSize.MICRO)
}

export const stgParameter: Parameter = {
  env,
  prefix: 'kasio-stg',
  vpcId: 'bbbbbbbbbb',
  instanceType: ec2.InstanceType.of(ec2.InstanceClass.T2, ec2.InstanceSize.SMALL)
}

export const prdParameter: Parameter = {
  env,
  prefix: 'kasio-prd',
  vpcId: 'cccccccccc',
  instanceType: ec2.InstanceType.of(ec2.InstanceClass.T2, ec2.InstanceSize.SMALL)
}
