---
name: code-review
description: TypeScript アプリケーションコードをレビュー。/code-review コマンドが呼ばれたとき、またはユーザーが TypeScript/React コードのレビューを依頼したときに使用する。型安全性・設計原則・セキュリティ・プロジェクトルール準拠を自動チェックする。
argument-hint: '[ファイルパス]'
context: fork
agent: code-reviewer-agent
---

TypeScript アプリケーションコードをレビューしてください。

**このコードは初心者が書いた前提で、細かい点まで徹底的にレビューしてください。** 「動いていそう」「概ね問題ない」で済ませず、判断に迷ったら甘くせず厳しい側に倒してください。ただし、機械で測れる領域（型 `any`・Import 順序・未使用宣言・関数長・引数数・マジックナンバー・ネスト深度など）は ESLint/knip の CI ゲートが担保するため、そこはやり直さず、**機械で測れない判断項目——命名の意味・重複（DRY）の文脈判断・単一責任・コメント品質・エラー処理・設計の妥当性——を nit レベルまで漏らさず厳しく見てください**（機械化済み／判断項目の切り分けは references/review-criteria.md）。

レビューの前に `.claude/rules/typescript.md` を必ず Read し、そのうち機械化されない規約（命名の意味・改行スタイル・コメント方針・例外処理の設計）への準拠を1項目ずつ照合してください。違反は1件残らずレポートに反映してください。

レビューでは以下のポリシーにも従って評価してください。各ポリシーが判定基準の SSOT であり、具体チェックはポリシー側にあります（本ファイルへ転記しない）。各ポリシーは対応する採点観点に紐づきます（references/review-criteria.md）。

- `docs/policy/code-comment-policy.md` — コメント（#9）
- `docs/policy/configuration-policy.md` — 構成値・設定の扱い（#18）
- `docs/policy/application-design-policy.md` — コード内部設計（#19）
- `docs/policy/application-logging-policy.md` — ログ出力（#20。ログ出力を含む場合）
- `docs/policy/frontend-design-policy.md` — **フロントエンドコードのレビュー時のみ**（#21）
- `docs/policy/unit-test-policy.md` — **テストコードのレビュー時のみ**（#22）

引数: $ARGUMENTS
