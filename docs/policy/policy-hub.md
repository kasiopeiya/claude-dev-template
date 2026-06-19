# Policy Hub

設計・実装・レビュー・git操作など、アクションを起こす前にポリシーを確認したい開発者・AIが、該当するポリシードキュメントを素早く見つけるためのハブ。

ポリシーはこのプロジェクトの憲法であり、すべての判断の北極星である。
設計・実装・レビュー・git操作など、何らかのアクションを起こす前に必ず該当するポリシーを参照し、その精神に沿って行動すること。

各ポリシーは frontmatter の `hook.applies-to`（グロブ配列）で適用対象ファイルを宣言し、ファイル編集時に PreToolUse hook（`.claude/hooks/policy-loader.mjs`）が該当ポリシーの参照を自動で促す。hook を効かせたいポリシーには `applies-to` を付与すること。

---

## ポリシー一覧

### [refined-engineer-judgment-principles.md](refined-engineer-judgment-principles.md)
**概要**: 全ポリシーの上位に立つ横断原則（トレードオフの比較衡量・決定を遅らせる・シフトレフト・コードは負債・シンプルな発想で大きな変化）。判断の北極星。
**参照タイミング**: トレードオフ・設計選択・優先順位付けなど判断を迫られたすべての場面（他ポリシーで裁定できないときも）

---

### [judgment-log.md](../judgment-log.md)
**概要**: principles を実データから育てるための素材層（append-only）。AIの非自明な自律判断と人間からの矯正を生のまま記録し、分析して principles / rules / メモリへ昇格させる。規範ではなく観測データ置き場。
**参照タイミング**: 人間に判断を矯正された／トレードオフを伴う非自明な自律判断を下したとき（記録）。貯まった素材を原則へ昇格させるとき（分析）

---

### [git-policy.md](git-policy.md)
**概要**: コミットメッセージの書き方・粒度・rebase禁止・ブランチ命名規則
**参照タイミング**: commit作成・branch作成・PR作成・merge操作の前

---

### [pr-review-policy.md](pr-review-policy.md)
**概要**: レビューコメントのラベル体系（MUST/WANT/FYI/LGTM）・PRラベルとレビューケースの使い分け・PRサイズ感
**参照タイミング**: PRレビューを行う前・レビューコメントを書く前・PRをマージする前

---

### [documentation-policy.md](documentation-policy.md)
**概要**: ドキュメント作成の基本原則（対象読者と目的・なぜを書く・Progressive Disclosure・DRY・可視化・文章の書き方）
**参照タイミング**: 設計書・ドキュメントを作成・編集・レビューする前

---

### [code-comment-policy.md](code-comment-policy.md)
**概要**: コードコメントの種類別指針（実装コメント＝WHY／ドキュメンテーションコメント＝WHAT契約／ファイル冒頭コメント）・名前優先・コメントは腐る前提
**参照タイミング**: コードのコメントを書く・レビューする前

---

### [test-strategy-policy.md](test-strategy-policy.md)
**概要**: テスト系ポリシーのハブ。テストピラミッド（配分の嗅覚）・各層の責務分担・統合/E2Eの汎用設計指針とアンチパターン
**参照タイミング**: テストをどの層に書くか・統合/E2Eを設計する前

---

### [test-terms.md](../reference/test-terms.md)
**概要**: テスト用語の単一の真実（SSOT）。unit/integration/E2Eの定義・テストダブル5分類（dummy/stub/spy/mock/fake）
**参照タイミング**: テストの種類やテストダブルの呼称に迷ったとき・他者と認識を揃えたいとき

---

### [unit-test-policy.md](unit-test-policy.md)
**概要**: 単体テストの思想（古典学派）・テストダブル方針（モック/スタブ）・AAAパターン・命名規則・テスト対象の判断基準・カバレッジの考え方
**参照タイミング**: テストコードを実装・レビューする前

---

### [monitoring-policy.md](monitoring-policy.md)
**概要**: 監視・アラームのレビュー基準（根拠を持った項目選定と文書化・ブラックボックス/ホワイトボックスの使い分け・オオカミ少年・症状ベース・actionable・Runbook）。根拠の作り方は [GSMガイド](../guide/gsm-monitoring-guide.md) を推奨
**参照タイミング**: 監視・アラームを設計する前・作られた監視設定をレビューする前
