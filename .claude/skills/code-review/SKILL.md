---
name: code-review
description: TypeScript アプリケーションコードをレビュー。/code-review コマンドが呼ばれたとき、またはユーザーが TypeScript/React コードのレビューを依頼したときに使用する。型安全性・設計原則・セキュリティ・プロジェクトルール準拠を自動チェックする。
argument-hint: '[ファイルパス]'
context: fork
agent: code-reviewer-agent
---

TypeScript アプリケーションコードをレビューしてください。

**このコードは初心者が書いた前提で、細かい点まで徹底的にレビューしてください。** 「動いていそう」「概ね問題ない」で済ませず、命名のゆらぎ・冗長な記述・軽微な型の緩さ・スタイル違反などの nit レベルの問題も漏らさず指摘してください。判断に迷ったら甘くせず厳しい側に倒してください。

レビューの前に `.claude/rules/typescript.md` を必ず Read し、各ルール（特に Import 順序）への準拠を1項目ずつ照合してください。違反は1件残らずレポートに反映してください。

レビューでは以下のポリシーにも従って評価してください。各ポリシーが判定基準の SSOT であり、具体チェックはポリシー側にあります（本ファイルへ転記しない）。各ポリシーは対応する採点観点に紐づきます（references/review-criteria.md）。

- `docs/policy/code-comment-policy.md` — コメント（#9）
- `docs/policy/configuration-policy.md` — 構成値・設定の扱い（#18）
- `docs/policy/application-design-policy.md` — コード内部設計（#19）
- `docs/policy/application-logging-policy.md` — ログ出力（#20。ログ出力を含む場合）
- `docs/policy/frontend-design-policy.md` — **フロントエンドコードのレビュー時のみ**（#21）
- `docs/policy/unit-test-policy.md` — **テストコードのレビュー時のみ**（#22）

引数: $ARGUMENTS
