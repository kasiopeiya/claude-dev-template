# ダイアグラムフォーマット仕様

サンプル: `references/aws-architecture.drawio`

---

## 1. AWSリソース構成図（`resource-{env}.drawio`）

draw.io XML形式。draw.io/diagrams.net で開くと公式AWSアイコン付きの構成図として表示される。

### 基本XML構造

```xml
<?xml version="1.0" encoding="UTF-8"?>
<mxfile>
  <diagram name="{env}-architecture">
    <mxGraphModel dx="1302" dy="537" grid="1" gridSize="10" guides="1"
                  tooltips="1" connect="1" arrows="1" fold="1" page="1"
                  pageScale="1" pageWidth="1200" pageHeight="900"
                  background="#FFFFFF" math="0" shadow="0">
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
        <!-- ノードとエッジをここに追加 -->
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
```

### ノードの基本形式

```xml
<!-- アイコンノード（アイコン本体。ラベルは別ノードで定義する） -->
<mxCell id="{ID}" value="" style="{スタイル}" vertex="1" parent="{親ID}">
  <mxGeometry x="{x}" y="{y}" width="60" height="60" as="geometry"/>
</mxCell>

<!-- ラベルノード（アイコンの下に配置） -->
<mxCell id="{ID}_label" value="{表示名}" style="text;html=1;strokeColor=none;fillColor=none;align=center;verticalAlign=middle;whiteSpace=wrap;rounded=0;fontSize=11;fontStyle=1;" vertex="1" parent="1">
  <mxGeometry x="{x-30}" y="{y+55}" width="120" height="30" as="geometry"/>
</mxCell>
```

- `parent` は通常 `"1"`。グループ内のノードは親グループのIDを指定する
- IDはファイル内で一意（`"cf1"`, `"s3_bucket"` 等、意味のある名前を推奨）
- アイコンノードの `value` は `""` にし、ラベルは別ノードで定義する

### AWSサービスのアイコンスタイル

**共通部分（`{fill}` `{gradient}` `{resIcon}` だけ変える）:**

```
sketch=0;points=[[0,0,0],[0.25,0,0],[0.5,0,0],[0.75,0,0],[1,0,0],[0,1,0],[0.25,1,0],[0.5,1,0],[0.75,1,0],[1,1,0],[0,0.25,0],[0,0.5,0],[0,0.75,0],[1,0.25,0],[1,0.5,0],[1,0.75,0]];outlineConnect=0;fontColor=#232F3E;gradientColor={gradient};gradientDirection=north;fillColor={fill};strokeColor=#ffffff;dashed=0;verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;fontSize=12;fontStyle=0;aspect=fixed;shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.{service};
```

**サービス別の色とアイコン名:**

| サービス | fillColor | gradientColor | resIcon |
|---------|-----------|---------------|---------|
| CloudFront | `#5A30B5` | `#945DF2` | `cloudfront` |
| S3 | `#277116` | `#60A337` | `s3` |
| Lambda | `#D05C17` | `#F78E04` | `lambda` |
| DynamoDB | `#3334B9` | `#4D72F3` | `dynamodb` |
| Cognito | `#C7131F` | `#F54749` | `cognito` |
| Secrets Manager | `#C7131F` | `#F54749` | `secrets_manager` |
| SSM Parameter Store | `#C7131F` | `#F54749` | `systems_manager` |
| API Gateway | `#C7131F` | `#F54749` | `api_gateway` |
| SQS | `#C7131F` | `#F54749` | `sqs` |
| SNS | `#C7131F` | `#F54749` | `sns` |
| RDS | `#C7131F` | `#F54749` | `rds` |
| ECS | `#ED7100` | `#F78E04` | `ecs` |
| ECR | `#ED7100` | `#F78E04` | `ecr` |
| ALB | `#8C4FFF` | `#945DF2` | `application_load_balancer` |
| Route 53 | `#8C2FC7` | `#945DF2` | `route_53` |
| EventBridge | `#C7131F` | `#F54749` | `eventbridge` |
| Step Functions | `#C7131F` | `#F54749` | `step_functions` |
| SES | `#C7131F` | `#F54749` | `ses` |

**Usersアイコン（特別スタイル）:**

```xml
<mxCell id="users" value="" style="sketch=0;outlineConnect=0;fontColor=#232F3E;gradientColor=none;fillColor=#232F3D;strokeColor=none;dashed=0;verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;fontSize=12;fontStyle=0;aspect=fixed;pointerEvents=1;shape=mxgraph.aws4.users;labelBackgroundColor=#FFFFFF;" vertex="1" parent="1">
  <mxGeometry x="{x}" y="{y}" width="60" height="60" as="geometry"/>
</mxCell>
```

**HTMLアイコン（Hosted UI等）:**

```xml
<mxCell id="hosted_ui" value="Hosted UI" style="dashed=0;outlineConnect=0;html=1;align=center;labelPosition=center;verticalLabelPosition=bottom;verticalAlign=top;shape=mxgraph.weblogos.html5" vertex="1" parent="1">
  <mxGeometry x="{x}" y="{y}" width="36" height="51" as="geometry"/>
</mxCell>
```

### グループ（コンテナ）のスタイル

**AWS Cloud:**

```xml
<mxCell id="aws_cloud" value="" style="points=[[0,0],[0.25,0],[0.5,0],[0.75,0],[1,0],[1,0.25],[1,0.5],[1,0.75],[1,1],[0.75,1],[0.5,1],[0.25,1],[0,1],[0,0.75],[0,0.5],[0,0.25]];outlineConnect=0;gradientColor=none;html=1;whiteSpace=wrap;fontSize=12;fontStyle=0;container=1;pointerEvents=0;collapsible=0;recursiveResize=0;shape=mxgraph.aws4.group;grIcon=mxgraph.aws4.group_aws_cloud_alt;strokeColor=#232F3E;fillColor=none;verticalAlign=top;align=left;spacingLeft=30;fontColor=#232F3E;dashed=0;" vertex="1" parent="1">
  <mxGeometry x="140" y="130" width="1060" height="610" as="geometry"/>
</mxCell>
<!-- ラベル（グループ内に配置） -->
<mxCell id="aws_cloud_label" value="AWS Cloud" style="text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;whiteSpace=wrap;rounded=0;fontSize=16;fontStyle=1;fontColor=#232F3E;" vertex="1" parent="aws_cloud">
  <mxGeometry x="30" width="100" height="30" as="geometry"/>
</mxCell>
```

**Region:**

```xml
<mxCell id="region" value="" style="points=[[0,0],[0.25,0],[0.5,0],[0.75,0],[1,0],[1,0.25],[1,0.5],[1,0.75],[1,1],[0.75,1],[0.5,1],[0.25,1],[0,1],[0,0.75],[0,0.5],[0,0.25]];outlineConnect=0;gradientColor=none;html=1;whiteSpace=wrap;fontSize=12;fontStyle=0;container=1;pointerEvents=0;collapsible=0;recursiveResize=0;shape=mxgraph.aws4.group;grIcon=mxgraph.aws4.group_region;strokeColor=#147EBA;fillColor=none;verticalAlign=top;align=left;spacingLeft=30;fontColor=#147EBA;dashed=1;" vertex="1" parent="1">
  <mxGeometry x="180" y="170" width="960" height="550" as="geometry"/>
</mxCell>
```

**任意のグループボックス（Stackグループ・Lambda Function URLsのような枠）:**

```xml
<!-- ボックス -->
<mxCell id="my_group" value="" style="rounded=1;whiteSpace=wrap;html=1;fillColor=none;strokeColor=#FF9900;strokeWidth=2;dashed=1;" vertex="1" parent="1">
  <mxGeometry x="{x}" y="{y}" width="{w}" height="{h}" as="geometry"/>
</mxCell>
<!-- ラベル -->
<mxCell id="my_group_label" value="{グループ名}" style="text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;whiteSpace=wrap;rounded=0;fontSize=12;fontStyle=1;fontColor=#FF9900;" vertex="1" parent="1">
  <mxGeometry x="{x+10}" y="{y-20}" width="200" height="20" as="geometry"/>
</mxCell>
```

strokeColorのカラーリング例: `#FF9900`（オレンジ）, `#147EBA`（青）, `#C7131F`（赤）

**アイコングループ（group + connectable=0）:**

複数のノード（アイコン＋ラベル）を1つの論理ユニットとしてまとめる場合：

```xml
<mxCell id="lambda_group" value="" style="group" vertex="1" connectable="0" parent="1">
  <mxGeometry x="{x}" y="{y}" width="140" height="95" as="geometry"/>
</mxCell>
<!-- 子ノードの parent をグループIDにする -->
<mxCell id="lambda_icon" value="" style="...resourceIcon..." vertex="1" parent="lambda_group">
  <mxGeometry x="40" width="60" height="60" as="geometry"/>
</mxCell>
<mxCell id="lambda_label" value="{name}" style="text;..." vertex="1" parent="lambda_group">
  <mxGeometry y="53" width="140" height="35" as="geometry"/>
</mxCell>
```

### エッジスタイル

```xml
<!-- 標準実線矢印 -->
<mxCell id="{ID}" value="{ラベル}" style="endArrow=classic;html=1;rounded=0;strokeWidth=2;strokeColor=#232F3E;" edge="1" source="{srcID}" target="{tgtID}" parent="1">
  <mxGeometry relative="1" as="geometry"/>
</mxCell>

<!-- 双方向矢印（Read/Write等） -->
<mxCell ... style="endArrow=classic;startArrow=classic;html=1;rounded=0;strokeWidth=2;strokeColor=#3334B9;" ...>

<!-- 破線矢印（参照・リダイレクト） -->
<mxCell ... style="endArrow=classic;startArrow=classic;html=1;rounded=0;strokeWidth=2;strokeColor=#C7131F;dashed=1;..." ...>

<!-- エッジラベル -->
<mxCell id="{edge_ID}_label" value="{ラベルテキスト}" style="edgeLabel;html=1;align=center;verticalAlign=middle;resizable=0;points=[];fontSize=10;" vertex="1" connectable="0" parent="{edge_ID}">
  <mxGeometry relative="1" as="geometry">
    <mxPoint x="{offset_x}" y="{offset_y}" as="offset"/>
  </mxGeometry>
</mxCell>
```

矢印色の使い分け（サンプルに準拠）:

| 用途 | strokeColor |
|-----|-------------|
| 標準フロー | `#232F3E`（黒） |
| S3へのルーティング | `#277116`（緑） |
| Lambda/Computeへ | `#D05C17`（オレンジ） |
| DB Read/Write | `#3334B9`（青） |
| Auth/Security系 | `#C7131F`（赤） |
| 破線（リダイレクト等） | `#C7131F` + `dashed=1` |

### テキストノート

```xml
<mxCell id="note_1" value="{注記テキスト}" style="whiteSpace=wrap;html=1;" vertex="1" parent="aws_cloud">
  <mxGeometry x="{x}" y="{y}" width="120" height="30" as="geometry"/>
</mxCell>
```

### 環境差分の表現

環境固有のノードには色付きテキストノートを追加する：

```xml
<mxCell id="diff_note" value="&lt;b&gt;環境差分&lt;/b&gt;&lt;br&gt;dev: ...&lt;br&gt;prod: ..." style="text;html=1;strokeColor=#FF9900;fillColor=#fff2cc;align=left;verticalAlign=top;spacingLeft=4;overflow=hidden;fontSize=11;" vertex="1" parent="1">
  <mxGeometry x="{x}" y="{y}" width="200" height="80" as="geometry"/>
</mxCell>
```

---

## 2. Stack構成図（`stack-diagram.md`）

```markdown
# Stack構成図

> 生成日時: {date}

## 依存関係図

\`\`\`mermaid
classDiagram
    class {StackA} {
        +{exportしている値・リソース名}
    }
    class {StackB} {
        +{exportしている値・リソース名}
    }
    {StackA} --> {StackB} : {参照リソース名}
\`\`\`

## クロススタック参照一覧

| 参照元Stack | 参照先Stack | 参照リソース | 用途 |
|-----------|-----------|------------|-----|

## 環境別Stackの組み合わせ

| 環境 | 使用Stacks |
|-----|-----------|
```

**記法ルール:**
- classの属性: そのStackがexportしている値・リソースを `+` で列挙
- 矢印の向き: 依存している方向（参照元 → 参照先）

---

## 3. Constructツリー（`construct-tree.md`）

```markdown
# Constructツリー

> 生成日時: {date}
> ソース: {tree.json から生成 / コードから推定}

\`\`\`mermaid
graph TD
    App(["🌳 App"])
    App --> Stack1(["📦 Stack1"])
    Stack1 --> Construct1["🔧 Construct1<br/>{CDKクラス名}"]
    Construct1 --> Nested["🔧 Nested<br/>{CDKクラス名}"]
\`\`\`

## ノード説明

| ノード | タイプ | 説明 |
|-------|-------|-----|
```

**記法ルール:**
- App: `(["🌳 App"])` / Stack: `(["📦 {名前}"])` / L2: `["🔧 {名前}<br/>{クラス名}"]` / L1(Cfn): `["⚙️ {名前}<br/>{CFnタイプ}"]`
- L2の内部で生成されるL1（`CfnXxx`）は表示しない

---

## 4. インデックス（`README.md`）

```markdown
# CDK Visualization

> 生成日時: {date}
> プロジェクト: {cdk.jsonのappから取得}

## ドキュメント一覧

### AWSリソース構成図（環境別）
- [resource-{env}.drawio](resource-{env}.drawio) - {env}環境（draw.io形式）

### Stack構成図
- [stack-diagram.md](stack-diagram.md)

### Constructツリー
- [construct-tree.md](construct-tree.md)

## 環境サマリー

| 環境 | Stacks | 主要リソース |
|-----|--------|-----------|
```
