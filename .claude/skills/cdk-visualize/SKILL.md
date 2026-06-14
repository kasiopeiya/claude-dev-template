---
name: cdk-visualize
description: CDKコードを解析してAWSリソース構成図・Stack依存関係図・Constructツリーを生成し、cdk.out/visualization/に出力する。CDKプロジェクトの可視化を依頼されたときに使用すること。
context: fork
agent: general-purpose
disable-model-invocation: true
---

CDKプロジェクトを解析し、以下の3種類の可視化ドキュメントを `cdk.out/visualization/` に生成してください。

## 解析手順

### 1. プロジェクト構造の把握

以下を順番に確認する：

1. `StackBuilder.ts` を探す（なければ `bin/*.ts`）→ 環境名とStack組み合わせを把握
2. `lib/` 配下の全Stackファイル（`*Stack.ts`, `*-stack.ts`）を読む
3. `cdk.out/tree.json` が存在すれば読む
4. `cdk.json` でプロジェクト設定を確認

### 2. 抽出する情報

- 各StackのAWSリソース一覧と相互接続（`grantRead/Write`, `addTrigger`, `addOrigin` 等）
- クロススタック参照（他Stackのプロパティを引数として受け取っている箇所）
- 環境ごとの差分（StackBuilder.tsや環境設定から）

### 3. 生成するファイル

| ファイル | 内容 |
|---------|------|
| `resource-{env}.drawio` | 環境別AWSリソース構成図（draw.io XML形式） |
| `stack-diagram.md` | Stack間依存関係（Mermaid classDiagram） |
| `construct-tree.md` | Constructツリー（Mermaid graph） |
| `README.md` | インデックス |

各ファイルのフォーマットは `references/diagram-formats.md` を参照すること。

## 出力ルール

- `cdk.out/visualization/` がなければ作成する（`cdk.out` ごと作成してよい）
- ARN・アカウントID等の機密情報は `{account-id}` 等のプレースホルダーに置換する
- tree.json が存在しない場合（cdk synth未実行）はコードから推定し、その旨をファイル内に明記する
- 生成完了後、生成したファイル一覧を報告する
