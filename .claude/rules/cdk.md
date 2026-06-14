---
globs: cdk/**/*
---

# CDK 実装ルール

## Construct レベル

- 可能な限り L2 Construct（High-level API）を使用すること
- IAM Role は L2 Construct の自動生成機能を活用し、明示的な Role 定義は避けること
- コードが長くなりすぎる場合は、必要に応じて L3 Construct（カスタム Construct）を作成すること

## import 形式

aws-cdk-lib のサービスモジュールは以下の形式で統一すること：

```typescript
// ✅ 正しい形式
import { aws_s3 as s3 } from 'aws-cdk-lib'
import { aws_lambda as lambda } from 'aws-cdk-lib'
import { aws_cognito as cognito } from 'aws-cdk-lib'

// ❌ 避けるべき形式
import * as s3 from 'aws-cdk-lib/aws-s3'
import { Bucket } from 'aws-cdk-lib/aws-s3'
```

## import 順序の例

```typescript
// 1. 標準ライブラリ
import * as path from 'path'

// 2. サードパーティライブラリ（CDK 含む）
import { Stack, StackProps, RemovalPolicy } from 'aws-cdk-lib'
import { aws_s3 as s3 } from 'aws-cdk-lib'
import { aws_lambda as lambda } from 'aws-cdk-lib'
import { aws_lambda_nodejs as nodejs } from 'aws-cdk-lib'
import { aws_cognito as cognito } from 'aws-cdk-lib'
import { aws_apigatewayv2 as apigw } from 'aws-cdk-lib'
import { aws_cloudfront as cloudfront } from 'aws-cdk-lib'
import { Construct } from 'constructs'

// 3. 自作モジュール
import { AppParameter } from '../parameter'
```


## CDKの差分検知ルール

このプロジェクトでは、`cdk diff`による正確な差分検知と、決定論的（予測可能）なインフラ構築を最優先します。CloudFormationのデプロイ時評価機能（動的参照や条件分岐）への依存を排除し、すべてを「CDK Synth時」に解決する静的な実装を行ってください。

以下のルールを厳守してコードを生成・修正してください。

### 1. DON'T: 動的参照（Dynamic References）の利用

デプロイ実行時まで値が確定しないSSMやSecrets Managerの動的参照は使用しないでください。代わりに、Synth時に値を取得してキャッシュするContextルックアップを使用してください。

* **Bad (差分が出ない):**
```typescript
// デプロイ時に評価されるためdiffで検知不可
const amiId = ssm.StringParameter.fromStringParameterName(this, 'Ami', '/my/ami').stringValue;

```

### 2. DON'T: CloudFormation `Parameters` の利用

実行時に外部から値を注入する`CfnParameter`は使用しないでください。代わりに、CDKのContext（`cdk.json`）やTypeScriptのプロパティを利用し、Synth時に値を固定してください。

* **Bad:**
```typescript
const envType = new CfnParameter(this, 'EnvType', { type: 'String' });

```

### 3. DON'T: CloudFormation `Conditions` の利用

テンプレート内に分岐ロジックを残す`CfnCondition`や`Fn.conditionIf`は使用しないでください。代わりに、TypeScriptのネイティブな制御構文（`if`文）を使用して、不要なリソースはテンプレートから完全に除外してください。

* **Bad:**
```typescript
const isProd = new CfnCondition(this, 'IsProd', { expression: Fn.conditionEquals(env, 'prod') });

```

### 4. DON'T: 非決定的な値を出力するカスタムリソース

実行のたびに結果が変わる（外部APIの最新取得など）カスタムリソースは原則使用しないでください。動的な値が必要な場合は、ビルドスクリプト等で事前に取得し、CDKへは静的な値として渡してください。

* **Bad:** Lambda内でAPIをフェッチし結果を後続に渡すCustomResource

### 5. MUST: `cdk.context.json` のバージョン管理

ルックアップ情報を含む `cdk.context.json` は必ずソース管理（Git）に含めてください。意図しない削除や変更を避けてください。

### 6. DON'T: 物理ID（Physical Name）の動的生成

Synthのたびに物理名が変わると `cdk diff` で毎回「リソースの削除→再作成」として検知され、意図しないダウンタイムやデータ消失につながります。また、CloudFormationはリソースの同一性を物理名で追跡するため、名前が変わると既存リソースを削除して新規作成しようとし、削除保護が機能しない場合は実データが失われます。

実行時評価に依存する物理名生成や、動的な変数での名前指定は避けてください。リソース名はCDKの論理ID管理に任せるか、`PhysicalName.GENERATE_IF_NEEDED` を使用してください。

* **Bad:**
```typescript
const bucket = new s3.Bucket(this, 'MyBucket', {
  bucketName: `my-app-${Date.now()}`, // Synthのたびに変わる
});

```

### 7. MUST: 依存関係の明示

L1コンストラクト等を使用し、自動解決されない依存関係がある場合は、デプロイ順序のエラーを防ぐため `node.addDependency()` を必ず明示してください。

* **Bad:**
```typescript
const rule = new events.CfnRule(...);
const target = new events.CfnTarget(...); // 順序が担保されない

```

* **Good:**
```typescript
target.node.addDependency(rule);
```

### 8. MUST: CDK内部でのSDK使用は読み取り専用に限定

既存リソースの取得目的でSDKを使用する場合、以下の制約を厳守してください。

読み取り専用: 情報取得（Describe/Get/List等）のみに使用し、書き込み操作は禁止。

実装: ヘルパーメソッドがないリソースは、検索キー（タグ等）を引数に取る関数でIDを取得し、L1コンストラクトへ直接渡す。

```typescript
async function getResourceId(tagKey: string, tagValue: string): Promise<string> {
  const client = new EC2Client({ region: 'ap-northeast-1' });
  const res = await client.send(new DescribeInstancesCommand({
    Filters: [{ Name: `tag:${tagKey}`, Values: [tagValue] }]
  }));
  return res.Reservations![0].Instances![0].InstanceId!;
}

// コンストラクト内
const rawId = await getResourceId('Role', 'legacy-system');
```
