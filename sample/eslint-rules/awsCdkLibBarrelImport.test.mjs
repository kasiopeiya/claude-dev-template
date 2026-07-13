// 責務: 自作ルール awsCdkLibBarrelImport の検出と fixer の挙動のみを検証する

import { RuleTester } from 'eslint'

import rule from './awsCdkLibBarrelImport.mjs'

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 'latest', sourceType: 'module' }
})

ruleTester.run('aws-cdk-lib-barrel-import', rule, {
  valid: [
    "import { aws_s3 as s3 } from 'aws-cdk-lib'",
    "import { Stack, StackProps } from 'aws-cdk-lib'",
    "import { Construct } from 'constructs'",
    // サービスモジュール以外（assertions など）は対象外
    "import { Template } from 'aws-cdk-lib/assertions'"
  ],
  invalid: [
    {
      // 名前空間 import は barrel 形式へ自動修正される
      code: "import * as s3 from 'aws-cdk-lib/aws-s3'",
      output: "import { aws_s3 as s3 } from 'aws-cdk-lib'",
      errors: [{ messageId: 'useBarrelNamespace' }]
    },
    {
      // ハイフン区切りのサービス名もアンダースコアへ変換される
      code: "import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs'",
      output: "import { aws_lambda_nodejs as nodejs } from 'aws-cdk-lib'",
      errors: [{ messageId: 'useBarrelNamespace' }]
    },
    {
      // 名前付き import は使用箇所の書き換えを伴うため検出のみ（output は変わらない）
      code: "import { Bucket } from 'aws-cdk-lib/aws-s3'",
      output: null,
      errors: [{ messageId: 'useBarrelNamed' }]
    }
  ]
})

// RuleTester.run はテストフレームワーク未検出時に同期実行され、失敗時に throw する。
// ここまで到達すれば全ケース成功。
console.log('aws-cdk-lib-barrel-import: all rule tests passed')
