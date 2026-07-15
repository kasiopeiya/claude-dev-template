# Design Hub

実装・調査・レビュー・質問への回答など、**あらゆるタスクの開始前に最初に参照する**全設計書のハブ。個別の設計書は必ずここを経由して読む。

設計書は「コードから読み取れないこと」——構造・流れ・**なぜ**——だけを書く。何が良い設計書かは [design-doc-policy](policy/design-doc-policy.md) が定める。判断の基準（ポリシー）は [policy-hub](policy-hub.md) を参照する。

---

## 設計書一覧

### [cicd-design.md](design/cicd-design.md)
**概要**: CI/CD パイプラインの設計。芯は「**deploy 成功をレビューの Entry Criteria とする**」——CDK は deploy しないと分からないエラーが多いため、PR マージ**前**に dev へ deploy する
**参照タイミング**: `.github/` 配下のワークフローを変更・レビューする前、CI がなぜこの構成なのかを知りたいとき

---

## ADR（意思決定の経緯）

設計書が答えるのは「なぜ**今**この構造か」。「なぜ**旧設計から変えたか**」は ADR の領分（[design-doc-policy](policy/design-doc-policy.md)）。

- [adr-index.md](adr/adr-index.md) — ADR の一覧
