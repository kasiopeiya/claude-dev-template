# ADR インデックス

対象読者：設計を変える前や、なぜ今の設計になったかを知りたいときに、過去の決定を探す人・AI。

下の表は各 ADR の frontmatter（`status` / `date`）から `npm run gen:adr-index` で機械生成する。**表は直接編集しない**（編集しても再生成で上書きされる）。作成は `/create-adr`、テンプレートは [adr-template.md](adr-template.md)。

ステータスの値：提案（proposed） / 承認（accepted） / 却下（rejected） / 廃止（deprecated） / 置換（superseded）

<!-- ADR_INDEX_TABLE:START -->

| No. | タイトル                                                                                                                                 | ステータス | 日付       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------- |
| 001 | [Issue を自動実装するオーケストレーターをローカルで走らせる](001-auto-programmer-runs-locally.md)                                        | 提案       | 2026-09-21 |
| 002 | [architecture-reviewer-agent を4レンズに分ける](002-architecture-reviewer-four-lenses.md)                                                | 提案       | 2026-09-23 |
| 003 | [architecture-reviewer-agent のレンズ分割を、1体での取りこぼし検証なしに進める](003-architecture-reviewer-lens-split-skip-validation.md) | 提案       | 2026-09-23 |
| 004 | [テストの無い分岐はカバレッジで挙げ、LLM はテストを書くべきかだけを判定する](004-coverage-lists-untested-branches.md)                    | 提案       | 2026-09-26 |

<!-- ADR_INDEX_TABLE:END -->
