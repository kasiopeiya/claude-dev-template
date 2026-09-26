---
status: proposed
date: 2026-09-26
---

# ADR-005: 週次の docs 整合性チェックは、GitHub Actions が起票だけを行い、実行は人間か Auto Programmer が行う

## 決定(何を選んだか)

`.github/workflows/doc-consistency-weekly.yml` は週1回、`/doc-consistency` の実行を依頼する Issue を起票するだけを行う。`/doc-consistency` の実行そのものは GitHub Actions 上では行わず、人間か Auto Programmer が起票された Issue を処理して実行する。

## 採用理由(なぜこれを選んだか)

このテンプレートは、GitHub Actions で Claude Code を使えないプロジェクトへの配布も前提にしている。実行そのものを Actions に持たせると、そうしたプロジェクトでは仕組みごと動かない。検出器（`/doc-consistency`）はすでに起票まで動いた実績があるので、新しく作るのは定期実行の起票だけで足りる。

## 検討した代替案(なぜ却下したか)

**決定の軸：週次の docs 整合性チェックを誰がどこで実行するか。**

| 案                                                                              | 内容                                                                 | 却下理由                                                                    |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| GitHub Actions 上で `claude-code-action` から直接 `/doc-consistency` を実行する | ワークフローの中で Claude Code を起動し、チェックまで完結させる      | GitHub Actions で Claude Code を使えないプロジェクトで動かない              |
| Claude Code の `/schedule`（クラウドの定期実行）を使う                          | リポジトリの外（Claude Code 側）でスケジュールを組み、定期実行させる | 設定がリポジトリに残らず、テンプレート利用者に届かず、PR でレビューできない |
| 人間が手動で定期的に実行する運用だけを決める                                    | 仕組みは作らず、運用ルールとして「週1回実行する」とだけ決める        | 忘れると止まる。実際にこれまで定期チェックとして回ってこなかった実績がある  |

## 参照

- Issue #651 — この決定を行った Issue
- [ADR-006](006-skip-weekly-issue-when-open.md) — 未処理の週次 Issue があるときの扱い
- [ADR-007](007-doc-consistency-excluded-from-normal-dev-flow.md) — 通常開発の実装フローでの扱い
