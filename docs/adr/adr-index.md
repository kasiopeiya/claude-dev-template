# ADR インデックス

対象読者：設計を変える前や、なぜ今の設計になったかを知りたいときに、過去の決定を探す人・AI。

下の表は各 ADR の frontmatter（`status` / `date`）から `npm run gen:adr-index` で機械生成する。**表は直接編集しない**（編集しても再生成で上書きされる）。作成は `/create-adr`、テンプレートは [adr-template.md](adr-template.md)。

ステータスの値：提案（proposed） / 承認（accepted） / 却下（rejected） / 廃止（deprecated） / 置換（superseded）

<!-- ADR_INDEX_TABLE:START -->

| No. | タイトル                                                                                                                                                   | ステータス | 日付       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------- |
| 001 | [Issue を自動実装するオーケストレーターをローカルで走らせる](001-auto-programmer-runs-locally.md)                                                          | 提案       | 2026-09-21 |
| 002 | [architecture-reviewer-agent を4レンズに分ける](002-architecture-reviewer-four-lenses.md)                                                                  | 提案       | 2026-09-23 |
| 003 | [architecture-reviewer-agent のレンズ分割を、1体での取りこぼし検証なしに進める](003-architecture-reviewer-lens-split-skip-validation.md)                   | 提案       | 2026-09-23 |
| 004 | [テストの無い分岐はカバレッジで挙げ、LLM はテストを書くべきかだけを判定する](004-coverage-lists-untested-branches.md)                                      | 提案       | 2026-09-26 |
| 005 | [`/doc-consistency` の重複確認はまとめ Issue の指摘単位で行い、完了済みと同じ指摘は再発として起票する](005-doc-consistency-duplicate-check-granularity.md) | 提案       | 2026-09-26 |
| 005 | [週次の docs 整合性チェックは、GitHub Actions が起票だけを行い、実行は人間か Auto Programmer が行う](005-doc-consistency-weekly-issue-only.md)             | 提案       | 2026-09-26 |
| 006 | [open な週次 docs 整合性チェック Issue があるときは、新しい週次 Issue を起票しない](006-skip-weekly-issue-when-open.md)                                    | 提案       | 2026-09-26 |
| 007 | [`/doc-consistency` は通常開発の実装フローに含めない(文書の分割・統合作業は例外)](007-doc-consistency-excluded-from-normal-dev-flow.md)                    | 提案       | 2026-09-26 |
| 008 | [週次 docs 整合性チェックの起点を、前回処理を終えた週次 Issue 以降に変わった `docs/**/*.md` にする](008-weekly-issue-scope-since-last-processed.md)        | 提案       | 2026-09-26 |

<!-- ADR_INDEX_TABLE:END -->
