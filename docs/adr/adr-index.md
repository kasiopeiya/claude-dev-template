# ADR インデックス

対象読者：設計を変える前や、なぜ今の設計になったかを知りたいときに、過去の決定を探す人・AI。

下の表は各 ADR の frontmatter（`status` / `date`）から `npm run gen:adr-index` で機械生成する。**表は直接編集しない**（編集しても再生成で上書きされる）。作成は `/create-adr`、テンプレートは [adr-template.md](adr-template.md)。

ステータスの値：提案（proposed） / 承認（accepted） / 却下（rejected） / 廃止（deprecated） / 置換（superseded）

<!-- ADR_INDEX_TABLE:START -->

| No. | タイトル                                                                                                                        | ステータス | 日付       |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------- |
| 013 | [レビュー系 subagent を、問いの種類で束ねたレンズごとに並列で走らせる](013-review-subagents-run-lenses-in-parallel.md)          | 提案       | 2026-09-27 |
| 014 | [「どれを選ぶか」は Policy に、選んだ後の How は Rule に分けて置く](014-separate-policy-and-rule-roles.md)                      | 提案       | 2026-09-27 |
| 015 | [元のフォルダで別セッションが動いているときだけ、専用の worktree に入って作業する](015-use-worktree-when-other-session-runs.md) | 提案       | 2026-10-03 |

<!-- ADR_INDEX_TABLE:END -->
