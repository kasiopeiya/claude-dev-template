# ADR インデックス

このプロジェクトの Architecture Decision Record（ADR）一覧。下の表は各 ADR の frontmatter（`status` / `date`）から `npm run gen:adr-index` で機械生成する。**表は直接編集しない**（編集しても再生成で上書きされる）。作成は `/create-adr`、テンプレートは [adr-template.md](../../../../docs/adr/adr-template.md)。

ADR の書式の手本もここにある。001 はフル版、002 は**軽量版**の見本。

ステータスの値：提案（proposed） / 承認（accepted） / 却下（rejected） / 廃止（deprecated） / 置換（superseded）

<!-- ADR_INDEX_TABLE:START -->

| No. | タイトル                                                                                             | ステータス | 日付       |
| --- | ---------------------------------------------------------------------------------------------------- | ---------- | ---------- |
| 001 | [dev への deploy を main マージ後に行う](001-post-merge-dev-deploy.md)                               | 提案       | 2026-08-20 |
| 002 | [cdk-nag の抑制を1ファイルに集約してスタック単位で適用する](002-cdk-nag-suppressions-in-one-file.md) | 提案       | 2026-09-02 |

<!-- ADR_INDEX_TABLE:END -->
