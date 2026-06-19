---
name: code-review
description: TypeScript アプリケーションコードをレビュー。/code-review コマンドが呼ばれたとき、またはユーザーが TypeScript/React コードのレビューを依頼したときに使用する。型安全性・設計原則・セキュリティ・プロジェクトルール準拠を自動チェックする。
argument-hint: '[ファイルパス]'
context: fork
agent: code-reviewer-agent
---

TypeScript アプリケーションコードをレビューしてください。

コメントのレビューでは `docs/policy/code-comment-policy.md` に従って評価してください（実装コメントが WHY を書いているか、doc comment が契約を書いているか、名前で消せるコメントがないか）。

引数: $ARGUMENTS
