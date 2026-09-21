# auto-programmer

ボードの Ready に積まれた Issue を1件拾い、AI に実装させて PR にするツール。

読むのは、**このツールを自分の環境で動かす／別のリポジトリへ持っていく人が、何が起きるかと、どこを直せばよいかを知りたいとき**。

## 何をするか

`npm run auto-programmer` を1回打つと、次の順に進んで終わる（1回の実行で1件だけ処理する）。

| 順  | すること                                                            | 担当                       |
| --- | ------------------------------------------------------------------- | -------------------------- |
| 1   | `gh` の認証と `claude` の有無の確認・AI 専用 clone の作成           | preflight                  |
| 2   | Ready かつ `ai-fixable` な open Issue を、番号の小さい順に1件選ぶ   | このツール                 |
| 3   | clone を `origin/main` へ戻し、トピックブランチを作り、依存を揃える | このツール                 |
| 4   | 選んだ Issue のカードを「In progress」へ動かす                      | このツール                 |
| 5   | clone の中で `claude -p "/auto-dev <番号>"` を起動する              | `.claude/skills/auto-dev/` |
| 6   | 実装・検証・コミット・push・PR 作成                                 | `/auto-dev`                |
| 7   | PR の URL と終了コードを記録ファイルへ1行追記する                   | このツール                 |

AI が触るのは **AI 専用 clone の中だけ**で、人間の作業ツリーには一切触れない。人間が編集中のファイルが AI のコミットへ混ざることはない。実行場所をローカルにした理由は [ADR-001](../../docs/adr/001-auto-programmer-runs-locally.md) にある。

## 使う前に済ませておくこと

GitHub CLI のログインと Claude Code の導入は、人の操作が要るので自動化できない。

```bash
gh auth login
```

これ以外の準備（clone・依存のインストール）は自動で行う。初回の実行だけ、そのぶん時間がかかる。

```bash
npm run auto-programmer
```

起動してよいのは人間だけである。AI のセッションから打つと `.claude/hooks/` が止める。権限確認を飛ばした `claude` を、AI が自分で増やせないようにするためである。

## 設定値（`config.mjs`）

接続先と表記はすべて `config.mjs` に集めてある。**他のファイルにこれらの値は書かれていない。**

| キー                          | 意味                                            | 調べ方                                         |
| ----------------------------- | ----------------------------------------------- | ---------------------------------------------- |
| `repository`                  | Issue と PR の相手（`owner/repo`）              | `gh repo view --json nameWithOwner`            |
| `baseBranch`                  | PR のマージ先。トピックブランチもここから切る   | `gh repo view --json defaultBranchRef`         |
| `board.owner`・`board.number` | GitHub Projects の持ち主と番号                  | `gh project list --owner <owner>`              |
| `board.statusFieldName`       | 進捗を持つフィールドの表記                      | `gh project field-list <番号> --owner <owner>` |
| `board.readyStatusName`       | 「着手してよい」を表す選択肢の表記              | 同上                                           |
| `board.inProgressStatusName`  | 「着手中」を表す選択肢の表記                    | 同上                                           |
| `targetIssueLabel`            | 対象にする Issue のラベル                       | `gh label list`                                |
| `sessionTimeoutMinutes`       | 1件ぶんの claude セッションを打ち切るまでの分数 | 実装に掛かる時間の上限として決める             |

フィールド ID・選択肢 ID は設定に持たせない。表記から実行時に引き直す。

AI 専用 clone と実行記録は `~/dev/auto-programmer/` の下に置かれる。置き場を変えたいときは、`config.mjs` を編集せず環境変数 `AUTO_PROGRAMMER_HOME` で指定する。

## 実行の記録

1回の実行につき1行の JSON が `runLogPath` に追記される。端末を閉じた後でも、いつ・どの Issue を・どうなったかを追える。

```bash
tail -3 ~/dev/auto-programmer/runs.jsonl | jq .
```

## 別のリポジトリで使うとき

直すのは次の3か所だけ。

- **`config.mjs`**：上の表の値をその環境のものへ書き換える
- **`package.json`**：`auto-programmer` と `test:scripts` のスクリプトを写す
- **`.claude/skills/auto-dev/`**：そのリポジトリの `.claude/skills/` へ写す（`/auto-dev` が無いと手順が無い）

`/auto-dev` は移した先の CLAUDE.md・Policy・hook をそのまま使う。実装の進め方をそのリポジトリに合わせたいときは、Issue 本文の「実装フロー（使用するSkill）」で指定する。

## 止まったとき

| 症状                                | 意味                                                           | 直し方                                                  |
| ----------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------- |
| 「GitHub CLI が未ログインです」     | `gh auth status` が通らない                                    | `gh auth login`                                         |
| 「着手できる Issue はありません」   | Ready に対象ラベル付きの open な Issue が無い                  | ボードのカードを Ready へ動かす                         |
| 「…という選択肢がありません」       | ボードの表記と `config.mjs` の表記が食い違っている             | `gh project field-list` の表示に合わせる                |
| 「claude コマンドが見つかりません」 | Claude Code が入っていない                                     | Claude Code を入れる                                    |
| 「リモートに … が残っています」     | 同じ Issue のブランチが前回の実行から残っている                | 前回の PR を閉じてブランチを消す                        |
| Issue が「In progress」のまま残った | `/auto-dev` が離脱した（Issue にコメントとラベルが残っている） | コメントを読み、専用のセッションでその Issue に着手する |
| 同上で、Issue にコメントが無い      | セッションが打ち切られたか、起動後に落ちた                     | 記録の `signal`・`error` を読んで原因を直す             |
