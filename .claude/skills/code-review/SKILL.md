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

コメントのレビューでは `docs/policy/code-comment-policy.md` に従って評価してください（実装コメントが WHY を書いているか、doc comment が契約を書いているか、名前で消せるコメントがないか）。

引数: $ARGUMENTS
