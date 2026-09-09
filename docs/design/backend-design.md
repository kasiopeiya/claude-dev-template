# バックエンドアプリケーション設計

バックエンドの**アプリケーションコード**（`app/` 配下）を変更・レビューする開発者／AI が、**なぜこの構造なのか**を知りたいときに参照する。
ロジックの実装・具体値はコードが正であり、本書はそこから読み取れない構造・流れ・なぜを書く。

> [!IMPORTANT]
> **本書はアプリケーションレベルの設計書である。** AWS リソース構成・ネットワーク・IaC・デプロイ・監視はインフラの領分で、[infrastructure-design](infrastructure-design.md) が持つ。実行基盤の制約がアプリ構造を規定しているときは、その制約だけを「前提と制約」に書き、インフラ構成そのものは書かない。

## 目次

- [基本方針](#基本方針)
- [構成図](#構成図)
  - [レイヤー構成と依存方向](#レイヤー構成と依存方向)
  - [主要な処理の流れ](#主要な処理の流れ)
  - [データモデル図](#データモデル図)
- [前提と制約](#前提と制約)
- [重要なポイント](#重要なポイント)

> [!NOTE]
> 本ファイルは [design-doc-policy](../policy/design-doc-policy.md) が定める3本柱（基本方針・構成図・重要なポイント）のスケルトン。
> 設計判断の基準は [application-architecture-policy](../policy/application-architecture-policy.md) / [application-design-policy](../policy/application-design-policy.md) / [database-design-policy](../policy/database-design-policy.md) を参照する。
> 構成図の小見出しは想定される図の例。実際に描く図に合わせて増減してよい。
> 重要なポイントは、1項目1行の俯瞰一覧の表を置き、全項目を同名の `###` 節に展開する（最大10個・1項目1決定。上限は節の数で数える）。

## 基本方針

## 構成図

### レイヤー構成と依存方向

<details>
<summary>設計判断とその理由</summary>

</details>

### 主要な処理の流れ

<details>
<summary>設計判断とその理由</summary>

</details>

### データモデル図

<details>
<summary>設計判断とその理由</summary>

</details>

## 前提と制約

## 重要なポイント
