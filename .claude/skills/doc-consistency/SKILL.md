---
name: doc-consistency
description: docs/ 配下を横断的に走査し、文書間の重複（DRY違反）と矛盾を検出する。「doc-consistency」「ドキュメントの整合性を見て」と指示されたとき。単一文書の品質レビューは /doc-review。
argument-hint: '[file-path | hub]'
context: fork
agent: doc-consistency-reviewer-agent
---

ドキュメント横断の整合性レビュー（重複・矛盾の検出）を実行してください。

引数: $ARGUMENTS
