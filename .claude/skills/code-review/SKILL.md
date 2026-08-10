---
name: code-review
description: TypeScript / React アプリケーションコードをレビューする。「code-review」「コードをレビューして」と指示されたとき。
argument-hint: '[ファイルパス]'
context: fork
agent: code-reviewer-agent
---

TypeScript アプリケーションコードをレビューしてください。

**このコードは初心者が書いた前提で、細かい点まで徹底的にレビューしてください。** 「動いていそう」「概ね問題ない」で済ませず、**指摘には必ず該当コードの引用を添えてください**（引用が書けない指摘は出さない。判断に迷ったとき厳しい側へ倒してよいのは、引用は取れるが解釈が分かれる場合だけです）。ただし、機械で測れる領域（型 `any`・Import 順序・未使用宣言・関数長・引数数・マジックナンバー・ネスト深度など）は ESLint/knip の CI ゲートが担保するため、そこはやり直さず、**機械で測れない判断項目——命名の意味・重複（DRY）の文脈判断・単一責任・コメント品質・エラー処理・設計の妥当性——を nit レベルまで漏らさず厳しく見てください**（機械化済み／判断項目の切り分けは references/review-criteria.md）。

レビューの前に `.claude/rules/typescript.md` を必ず Read し、そのうち機械化されない規約への準拠を1項目ずつ照合してください。違反は1件残らずレポートに反映してください。

レビューでは以下のポリシーにも従って評価してください。各ポリシーが判定基準の SSOT であり、具体チェックはポリシー側にあります（本ファイルへ転記しない）。各ポリシーは対応する採点観点に紐づきます（references/review-criteria.md）。

- `docs/policy/code-comment-policy.md` — 観点「コメント」
- `docs/policy/configuration-policy.md` — 観点「構成管理ポリシー準拠」
- `docs/policy/application-design-policy.md` — 観点「アプリ設計ポリシー準拠」
- `docs/policy/application-logging-policy.md` — 観点「ロギングポリシー準拠」（ログ出力を含む場合）
- `docs/policy/frontend-design-policy.md` — 観点「フロントエンド設計ポリシー準拠」（**フロントエンドコードのレビュー時のみ**）
- `docs/policy/unit-test-policy.md` — 観点「単体テストポリシー準拠」（**テストコードのレビュー時のみ**）

引数: $ARGUMENTS
