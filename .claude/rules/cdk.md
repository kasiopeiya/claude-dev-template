---
paths:
  - 'infra/**/*.ts'
---

# CDK 実装ルール

[typescript.md](typescript.md) を継承し、ここでは **AWS CDK 固有の差分だけ**を定める。命名・改行スタイル・規模の上限などの共通ルールは typescript.md に、コメント規約は [code-comment-policy](../../docs/policy/code-comment-policy.md) に従う。

## 対象読者

CDK でインフラを書く／レビューする開発者・AIエージェントが、Construct の選び方・import 形式・`cdk diff` を壊さない書き方に迷ったとき。

## Construct レベル

- 可能な限り L2 Construct（High-level API）を使う
- IAM Role は L2 Construct の自動生成機能を活用し、明示的な Role 定義は避ける
- コードが長くなりすぎる場合は、必要に応じて L3 Construct（カスタム Construct）を作る

## import 形式

aws-cdk-lib のサービスモジュールは以下の形式で統一する。この形式でなければならない技術的な理由は無く、統一によって可読性を上げることが目的である。

```typescript
// ✅ 正しい形式
import { aws_s3 as s3 } from 'aws-cdk-lib'
import { aws_lambda as lambda } from 'aws-cdk-lib'
import { aws_cognito as cognito } from 'aws-cdk-lib'

// ❌ 避けるべき形式
import * as s3 from 'aws-cdk-lib/aws-s3'
import { Bucket } from 'aws-cdk-lib/aws-s3'
```

## import 順序に CDK をどう当てはめるか

順序そのものは typescript.md が定める。ここでは CDK を含む場合の当てはめだけを示す——**aws-cdk-lib と constructs はサードパーティ**、`parameter.ts` などは自作モジュールとして扱う。

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

なぜ決定論的な構築を最優先するか（設計判断）は [cdk-design-policy](../../docs/policy/cdk-design-policy.md) が定める——デプロイ時評価や実行のたびに変わる値に依存すると `cdk diff` が正しく出ず、意図しない再作成・データ消失を招くからだ。ここではそれを守るための具体ルールを定める。CloudFormation のデプロイ時評価機能（動的参照や条件分岐）への依存を排除し、すべてを「CDK Synth 時」に解決する静的な実装にする。

### DON'T: 動的参照（Dynamic References）の利用

デプロイ実行時まで値が確定しない SSM や Secrets Manager の動的参照は使わない。代わりに、Synth 時に値を取得して `cdk.context.json` へキャッシュする Context ルックアップを使う。

```typescript
// ❌ デプロイ時に評価されるためdiffで検知不可
const amiId = ssm.StringParameter.fromStringParameterName(this, 'Ami', '/my/ami').stringValue

// ✅ Synth時に解決され、値はcdk.context.jsonへキャッシュされる
const amiId = ssm.StringParameter.valueFromLookup(this, '/my/ami')
```

### DON'T: CloudFormation `Parameters` の利用

実行時に外部から値を注入する `CfnParameter` は使わない。代わりに、CDK の Context（`cdk.json`）や TypeScript のプロパティを使い、Synth 時に値を固定する。

```typescript
// ❌ デプロイ時に外部から差し込まれるためSynth時に値が定まらない
const envType = new CfnParameter(this, 'EnvType', { type: 'String' })

// ✅ parameter.ts の値を props で受け取り、Synth時に固定する
interface MyStackProps extends StackProps {
  readonly instanceSize: string
}
```

### DON'T: CloudFormation `Conditions` の利用

テンプレート内に分岐ロジックを残す `CfnCondition` や `Fn.conditionIf` は使わない。代わりに TypeScript のネイティブな制御構文（`if` 文）を使い、不要なリソースはテンプレートから完全に除外する。その `if` は Stack 内に撒かず Builder 層に置く——各 Stack を1環境ぶんの宣言に保つためで、置き場所の判断は cdk-design-policy が定める。

```typescript
// ❌ 分岐がテンプレートに残り、どちらが生きるかdiffで読めない
const isProd = new CfnCondition(this, 'IsProd', { expression: Fn.conditionEquals(env, 'prod') })
```

### DON'T: 非決定的な値を出力するカスタムリソース

実行のたびに結果が変わる（外部 API の最新取得など）カスタムリソースは原則使わない。動的な値が必要な場合は、ビルドスクリプト等で事前に取得し、CDK へは静的な値として渡す。

| 例      | 実装                                                            |
| ------- | --------------------------------------------------------------- |
| ❌ Bad  | Lambda 内で API をフェッチし、結果を後続へ渡す CustomResource   |
| ✅ Good | 事前に取得した値を `parameter.ts` に置き、props で Stack へ渡す |

### DON'T: 物理ID（Physical Name）の動的生成

Synth のたびに物理名が変わると `cdk diff` で毎回「リソースの削除→再作成」として検知され、意図しないダウンタイムやデータ消失につながる。また、CloudFormation はリソースの同一性を物理名で追跡するため、名前が変わると既存リソースを削除して新規作成しようとし、削除保護が機能しない場合は実データが失われる。

実行時評価に依存する物理名生成や、動的な変数での名前指定は避ける。リソース名は CDK の論理 ID 管理に任せるか、`PhysicalName.GENERATE_IF_NEEDED` を使う。

```typescript
// ❌ Synthのたびに物理名が変わり、毎回削除→再作成として検知される
const bucket = new s3.Bucket(this, 'MyBucket', {
  bucketName: `my-app-${Date.now()}`
})

// ✅ 物理名はCDKの論理ID管理に任せる
const bucket = new s3.Bucket(this, 'MyBucket')
```

### MUST: `cdk.context.json` のバージョン管理

ルックアップ情報を含む `cdk.context.json` は必ずソース管理（Git）に含める。意図しない削除や変更を避ける。

### MUST: 依存関係の明示

L1 コンストラクト等を使い、自動解決されない依存関係がある場合は、デプロイ順序のエラーを防ぐため `node.addDependency()` を必ず明示する。CDK はプロパティ経由の参照（`.ref` など）があれば依存関係を自動検出するが、固定文字列などプロパティ参照を介さない関連付けでは自動検出されない。

- **Bad（依存関係が自動検出されない）:**

```typescript
// eventBus.ref を使わず固定文字列で参照しているため、CDK が依存関係を自動検出できない
const eventBus = new events.CfnEventBus(this, 'Bus', { name: 'my-custom-bus' })
const rule = new events.CfnRule(this, 'Rule', {
  eventBusName: 'my-custom-bus',
  eventPattern: { source: ['custom.source'] }
})
```

- **Good:**

```typescript
rule.node.addDependency(eventBus)
```

### MUST: CDK内部でのSDK使用は読み取り専用に限定

既存リソースの取得目的で SDK を使う場合、以下の制約を厳守する。

| 制約         | 内容                                                                                                            |
| ------------ | --------------------------------------------------------------------------------------------------------------- |
| 読み取り専用 | 情報取得（Describe/Get/List 等）にだけ使う。書き込み操作は禁止                                                  |
| 呼び出し位置 | Construct のコンストラクタは `async` にできないため、SDK 呼び出しは app エントリで解決し、結果を props で渡す   |
| 渡し方       | ヘルパーメソッドが無いリソースは、検索キー（タグ等）を引数に取る関数で ID を取得し、L1 コンストラクトへ直接渡す |

```typescript
async function getResourceId(tagKey: string, tagValue: string): Promise<string> {
  const client = new EC2Client({ region: 'ap-northeast-1' })
  const res = await client.send(
    new DescribeInstancesCommand({
      Filters: [{ Name: `tag:${tagKey}`, Values: [tagValue] }]
    })
  )
  return res.Reservations![0].Instances![0].InstanceId!
}

interface MyStackProps extends StackProps {
  readonly legacyInstanceId: string
}

class MyStack extends Stack {
  constructor(scope: Construct, id: string, props: MyStackProps) {
    super(scope, id, props)
    new ec2.CfnEIPAssociation(this, 'EipAssociation', {
      instanceId: props.legacyInstanceId
    })
  }
}

// bin/app.ts（エントリポイント）
async function main() {
  const legacyInstanceId = await getResourceId('Role', 'legacy-system')
  const app = new App()
  new MyStack(app, 'MyStack', { legacyInstanceId })
}

main()
```

## Interface Segregation（ISP）

なぜ公開インターフェースを最小の型に絞るか（設計判断）は cdk-design-policy が定める——公開する型を広く取るほど利用者に余計な操作を許し、結合が強まるからだ。ここでは型の選択という実装戦術を定める。

### 型の選択基準

参照型は下ほど公開範囲が狭い。必要な操作に応じて **できるだけ下の型** を選ぶ。

```text
Bucket        ← Bucket 固有 API が必要な場合のみ（props / public では原則使わない）
  ↑
IBucket       ← grant系・addEventNotification・metric など L2 操作が必要な場合
  ↑
IBucketRef    ← 名前・ARN など識別情報のみで足りる場合（基本はこれ）
```

他リソースも同様（例: `IFunctionRef` / `IFunction` / `Function`）。

### 例

```typescript
import { aws_s3_notifications as s3n } from 'aws-cdk-lib'

// BucketProps を継承せず、必要な操作から逆算した最小の props にする
interface MyS3BucketProps {
  // grant / addEventNotification で L2 操作するため IFunction を要求
  readonly func: lambda.IFunction
  readonly removalPolicy?: RemovalPolicy
}

export class MyS3Bucket extends Construct {
  // 外部には識別情報のみ公開し、設定変更を許可しない
  public readonly bucket: s3.IBucketRef

  constructor(scope: Construct, id: string, props: MyS3BucketProps) {
    super(scope, id)
    const bucket = new s3.Bucket(this, 'Bucket', {
      autoDeleteObjects: true,
      removalPolicy: props.removalPolicy ?? RemovalPolicy.DESTROY,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true
    })
    bucket.grantDelete(props.func)
    bucket.addEventNotification(s3.EventType.OBJECT_CREATED, new s3n.LambdaDestination(props.func))
    this.bucket = bucket
  }
}
```
