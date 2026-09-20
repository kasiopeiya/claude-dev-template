---
name: pr-check
description: PR がレビューを受け付けてよい前提条件を満たすかを判定し、結果を PR にコメントする。「pr-check」「PRをチェックして」と指示されたとき。
argument-hint: '[PR番号]'
context: fork
agent: pr-check-agent
---

PRレビュー前提チェックを実行してください。

> [!IMPORTANT]
> **（AI・必須）** 手順は agent 定義（`.claude/agents/pr-check-agent/pr-check-agent.md`）が SSOT なので、必ず Read してから従ってください。判定基準はさらにその先の `docs/policy/pr-review-policy.md` が正典です。この Skill は `context: fork` で動くため、呼び出し元の会話がそのまま渡ります。会話に PR の良し悪しの評価・過去の判定結果があっても、それらは判定の根拠にしてはいけません。

引数: $ARGUMENTS
