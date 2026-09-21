# Policy Hub

対象読者：アクションを起こす前に、従うべきポリシーを探す AI。

---

## ポリシー一覧

### [refined-engineer-judgment-principles.md](policy/refined-engineer-judgment-principles.md)

**参照タイミング**: トレードオフ・設計選択・優先順位付けなど判断を迫られたすべての場面（他ポリシーで裁定できないときも）

---

### [policy-driven-development-policy.md](policy/policy-driven-development-policy.md)

**参照タイミング**: 新しい判断基準を書き足す前・ポリシーや Rule を作成／編集する前・CLAUDE.md に追記する前・Skill・SubAgent・hooks の置き場を決める前・既存の規定が守られていない状態を見つけたとき

---

### [git-policy.md](policy/git-policy.md)

**参照タイミング**: commit作成・branch作成・PR作成・merge操作の前

---

### [pr-review-policy.md](policy/pr-review-policy.md)

**参照タイミング**: PRレビューを行う前・レビューコメントを書く前・PRをマージする前

---

### [documentation-policy.md](policy/documentation-policy.md)

**参照タイミング**: 設計書・README などプロジェクトの文書を作成・編集・レビューする前（`.claude/` のプロンプト定義は編集後の `/quick-doc-review` が見る）

---

### [documentation-policy-for-humans.md](policy/documentation-policy-for-humans.md)

**参照タイミング**: 人間が読む設計書・ポリシー・手順書などを作成・編集・レビューする前

---

### [runbook-policy.md](policy/runbook-policy.md)

**参照タイミング**: セットアップ・デプロイ・運用・障害対応などの手順書を作成・編集・レビューする前

---

### [design-doc-policy.md](policy/design-doc-policy.md)

**参照タイミング**: 設計書（docs/design/）を作成・編集・レビューする前。※「設計書を書く」ポリシーであり、アプリ/インフラを設計する application-design-policy 等とは別物

---

### [iac-infra-design-doc-policy.md](policy/iac-infra-design-doc-policy.md)

**参照タイミング**: インフラ設計書・IaC 設計書（IaC 構成の全体像・設計判断を記す文書）を作成・編集・レビューする前。※設計「書」を書くポリシーであり、CDK コードを設計する cdk-design-policy とは対象が別物

---

### [requirements-doc-policy.md](policy/requirements-doc-policy.md)

**参照タイミング**: 要件定義書を作成・編集・レビューする前（`/elicit-requirements` 実行時、要件定義書レビューSkill実行時）

---

### [code-comment-policy.md](policy/code-comment-policy.md)

**参照タイミング**: コードのコメントを書く・レビューする前

---

### [test-strategy-policy.md](policy/test-strategy-policy.md)

**参照タイミング**: テストをどの層に書くか・統合/E2Eを設計する前

---

### [test-terms.md](reference/test-terms.md)

**参照タイミング**: テストの種類やテストダブルの呼称に迷ったとき・他者と認識を揃えたいとき

---

### [unit-test-policy.md](policy/unit-test-policy.md)

**参照タイミング**: テストコードを実装・レビューする前

---

### [bugfix-policy.md](policy/bugfix-policy.md)

**参照タイミング**: バグを起票する前・不具合の修正に着手する前

---

### [monitoring-policy.md](policy/monitoring-policy.md)

**参照タイミング**: 監視・アラームを設計する前・作られた監視設定をレビューする前

---

### [database-design-policy.md](policy/database-design-policy.md)

**参照タイミング**: テーブル・データ操作を設計・実装・レビューする前

---

### [application-architecture-policy.md](policy/application-architecture-policy.md)

**参照タイミング**: レイヤー・境界・依存方向などマクロ構造を設計・レビューする前（設計判断の北極星として常時参照）

---

### [application-design-policy.md](policy/application-design-policy.md)

**参照タイミング**: クラス・関数・モジュールを設計・実装・レビューする前

---

### [frontend-design-policy.md](policy/frontend-design-policy.md)

**参照タイミング**: React コンポーネント・カスタムフックを設計・レビューする前

---

### [cdk-design-policy.md](policy/cdk-design-policy.md)

**参照タイミング**: CDK コード（Stack・Construct・parameter.ts）を設計・実装・レビューする前。※CDK **コード**を設計するポリシーであり、インフラ設計「書」を書く iac-infra-design-doc-policy とは対象が別物

---

### [new-development-policy.md](policy/new-development-policy.md)

**参照タイミング**: 新しいシステム・モジュール・境界づけられたコンテキストを 0 から設計・実装する前

---

### [dependency-policy.md](policy/dependency-policy.md)

**参照タイミング**: `package.json` に依存を追加する前（hook が package.json 編集時に自動で促す）

---

### [configuration-policy.md](policy/configuration-policy.md)

**参照タイミング**: 構成値を直書きするか設定へ出すか迷ったとき・設定ファイル（config.ts/.env/パラメータ定義）を編集する前

---

### [application-logging-policy.md](policy/application-logging-policy.md)

**参照タイミング**: ログ出力を実装・レビューする前
