---
name: doc-review
description: Markdownドキュメントの品質をレビューする。種別を自動判定し、種別に応じた観点で評価する。「doc-review」「ドキュメントをレビューして」と指示されたとき。要件定義書は /requirements-review、実装との整合性は /validate-design を使う。
argument-hint: '[file-path]'
context: fork
agent: doc-reviewer-agent
---

ドキュメントレビューを実行してください。

引数: $ARGUMENTS
