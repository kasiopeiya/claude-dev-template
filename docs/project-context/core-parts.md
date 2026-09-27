# このプロジェクトのコア部分

このシステムの中核——**壊れると全体が回らなくなる部分**を、人間が一度だけ名指しした一覧。AI は重要性を自分で判断せず、この一覧と照合するだけにする。照合は「何が中核か」の記述で行い、「主な場所」は現物を探す手がかりとして使う。

使うのは `docs/policy/adr-policy.md` の判定（この一覧に載った部分についての決定で、変えるときに移行作業が要るものは ADR にする）である。

> [!NOTE]
> 下の表はテンプレート本体（AI 主体の開発を回すハーネスそのものが中核）のもの。**このテンプレートを使うプロジェクトは、自分のシステムのコアに書き換える**（例：課金の計算、認証、外部公開 API）。まだ決まっていなければ項目を空にする。空のときは、ADR 判定のコア部分についての作る条件が発火しない。
>
> このファイルはテンプレート同期の対象外なので、書き換えてもテンプレート側の更新で戻らない。

| コア部分              | 何が中核か                                               | 主な場所                                                                                                                                                                                                                    |
| --------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Policy の強制読み込み | 判断の基準を編集の直前に必ず読ませる仕組み               | `docs/policy/`・`.claude/hooks/policy-loader.mjs`                                                                                                                                                                           |
| CI のガードレール     | どのジョブがどの検査を呼んで、マージの合否を出すかの構成 | `.github/workflows/pipeline.yml`・`eslint.config.mjs`・`knip.jsonc`・`scripts/check-markdown-links.mjs`・`scripts/check-claude-md-size.mjs`・`scripts/check-rule-size.mjs`・`scripts/audit-dependencies.mjs`                |
| 開発フロー            | Issue 駆動の進め方と、変更種別ごとにどの Skill を使うか  | `CLAUDE.md`「開発フロー」・`docs/guide/development-flow.md`                                                                                                                                                                 |
| レビューの仕組み      | AI レビューのレンズ分割と、レンズごとの subagent         | `.claude/skills/code-review/`・`cdk-review/`・`doc-review/`・`arch-review/`、`code-reviewer-agent`・`cdk-reviewer-agent`・`doc-reviewer-agent`・`architecture-reviewer-agent`、`docs/policy/review-subagent-lens-policy.md` |

レビューの仕組みに `/doc-consistency` は含めない。通常の実装フローの外にある週次チェックで、止まっても開発は回る。
