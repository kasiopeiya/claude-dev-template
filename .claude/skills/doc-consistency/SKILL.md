---
name: doc-consistency
description: docs/ 配下のドキュメントを横断的に走査し、文書間の重複（DRY違反）と矛盾（同じ事柄の食い違い）を検出する。単一ドキュメントの品質レビュー（/doc-review）とは別物で、文書群全体の整合性を監査したいときに使う。引数なしで docs/ 全体、'hub' で design-hub 配下、ファイルパスでそのファイルを起点に他文書と突合する。
argument-hint: '[file-path | hub]'
context: fork
agent: doc-consistency-reviewer-agent
---

ドキュメント横断の整合性レビュー（重複・矛盾の検出）を実行してください。

引数: $ARGUMENTS
