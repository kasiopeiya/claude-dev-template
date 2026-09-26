---
status: proposed
date: 2026-09-26
---

# ADR-010: 週次コード Policy 準拠チェックは、docs 用の週次チェックとは別の Issue・別ラベルにする

## 決定(何を選んだか)

`app/`・`samples/app` を対象にした週次の Policy 準拠チェック（`/code-review` の2レンズ実行）は、専用ラベル `code-policy-weekly` を持つ独立した週次 Issue として起票する。docs 用の週次整合性チェック（ラベル `doc-consistency-weekly`）とは別の Issue・別のワークフロー（`.github/workflows/code-policy-weekly.yml`）にする。

## 採用理由(なぜこれを選んだか)

`scripts/doc-consistency-weekly-issue.mjs` は、専用ラベルの open な Issue が既にあれば起票しない（[ADR-006](006-skip-weekly-issue-when-open.md)）。1つの Issue に docs とコードの両方のタスクを載せると、どちらか一方が詰まって未処理のまま残ったとき、この「open なら起票しない」決まりによって両方のチェックが止まる。ラベルと Issue を分ければ、一方の遅延がもう一方の実行を妨げない。

## 検討した代替案(なぜ却下したか)

**決定の軸：週次コード Policy 準拠チェックを、どの Issue・ラベルで管理するか。**

| 案                               | 内容                                                             | 却下理由                                                                        |
| -------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| docs 用の週次 Issue に同居させる | `doc-consistency-weekly` の Issue 本文にコードのタスクも追記する | どちらかが詰まると、既存の「open なら起票しない」決まりで両方のチェックが止まる |

## 参照

- Issue #678 — この決定を行った Issue
- [ADR-006](006-skip-weekly-issue-when-open.md) — 未処理の週次 Issue があるときの扱い（同じ決まりをこの ADR でも踏襲する）
