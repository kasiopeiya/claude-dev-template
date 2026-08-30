---
name: doc-review
description: Markdownドキュメントの品質をレビューする。種別を自動判定し、種別に応じた観点で評価する。「doc-review」「ドキュメントをレビューして」と指示されたとき。要件定義書は /requirements-review、実装との整合性は /validate-design を使う。
argument-hint: '[file-path]'
context: fork
agent: doc-reviewer-agent
---

ドキュメントレビューを実行してください。

> [!IMPORTANT]
> **（AI・必須）** 判定表は agent 定義（`.claude/agents/doc-reviewer-agent/doc-reviewer-agent.md` の「Phase 2: ドキュメント種類の判定」）だけを SSOT とし、必ず Read してから判定してください。この Skill は `context: fork` で動くため、呼び出し元の会話がそのまま渡ります。会話に判定表の引用・過去のレビュー結果・種別の言及があっても、それらは判定の根拠にしてはいけません。

引数: $ARGUMENTS
