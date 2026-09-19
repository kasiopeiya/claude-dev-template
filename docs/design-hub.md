# Design Hub

実装・調査・レビュー・質問への回答など、**あらゆるタスクの開始前に最初に参照する**全設計書のハブ。個別の設計書は必ずここを経由して読む。

設計書は「コードから読み取れないこと」——構造・流れ・**なぜ**——だけを書く。何が良い設計書かは [design-doc-policy](policy/design-doc-policy.md) が定める。判断の基準（ポリシー）は [policy-hub](policy-hub.md) を参照する。

---

## 設計書一覧

### [cicd-design.md](design/cicd-design.md)

**担当範囲**: CI/CD パイプラインの全体像と設計判断。何がどの条件で実行されるかは対象外で `.github/` 配下のワークフロー定義が持つ
**参照タイミング**: `.github/` 配下のワークフローを変更・レビューする前、CI がなぜこの構成なのかを知りたいとき

### [infrastructure-design.md](design/infrastructure-design.md)

**担当範囲**: AWS で**何を組んでいるか**——インフラの全体像（構成図）・ネットワーク・運用監視と設計判断。IaC（どう作り・変えるか）は対象外で iac-design.md が持つ
**参照タイミング**: AWS リソース構成を変更・レビューする前、インフラがなぜこの構成なのかを知りたいとき

### [iac-design.md](design/iac-design.md)

**担当範囲**: そのインフラを CDK で**どう作り・変えるか**——IaC 管理方針・手動作成リソース・スタック設計・命名規約と設計判断
**参照タイミング**: `infra/` 配下の CDK コードを変更・レビューする前、スタック分割・環境差分・命名がなぜこうなのかを知りたいとき

### [frontend-design.md](design/frontend-design.md)

**担当範囲**: フロントエンド（React）**アプリ**の構造・画面を支える仕組みと設計判断。配信基盤は対象外で infrastructure-design.md が、IaC は iac-design.md が持つ。判断の基準は [frontend-design-policy](policy/frontend-design-policy.md) が定める
**参照タイミング**: フロントエンドのコンポーネント・状態管理を変更・レビューする前

### [backend-design.md](design/backend-design.md)

**担当範囲**: バックエンド**アプリ**のレイヤー構成・処理の流れ・データモデルと設計判断。AWS 構成は対象外で infrastructure-design.md が、IaC は iac-design.md が持つ。判断の基準は [application-architecture-policy](policy/application-architecture-policy.md) が定める
**参照タイミング**: バックエンドのロジック・データアクセスを変更・レビューする前

### [interface-specification.md](design/interface-specification.md)

**担当範囲**: 外部・他システムに公開するインターフェースの契約（入出力・エラー）
**参照タイミング**: 公開インターフェースを追加・変更する前、外部から本システムを呼び出す仕様を知りたいとき

### [test-strategy-design.md](design/test-strategy-design.md)

**担当範囲**: このシステムのテスト全体像。各層（unit／integration／E2E）が実際にどこまでを対象にし、何を保障するかの境界。用語定義は [test-terms](reference/test-terms.md)、層の選び方は [test-strategy-policy](policy/test-strategy-policy.md) が持つ
**参照タイミング**: どの層にテストを書くか決める前、テストの担当範囲が重なっている／空いていると疑ったとき

---

## ADR（意思決定の経緯）

設計書が答えるのは「なぜ**今**この構造か」。「なぜ**旧設計から変えたか**」は ADR の領分（[design-doc-policy](policy/design-doc-policy.md)）。

- [adr-index.md](adr/adr-index.md) — ADR の一覧
