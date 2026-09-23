# auto-programmer

ボードの Ready に積まれた Issue を1件ずつ拾い、AI に実装させて PR にするツール。

読むのは、**このツールを自分の環境で動かす／別のリポジトリへ持っていく人が、何が起きるかと、どこを直せばよいかを知りたいとき**。

## 何をするか

`npm run auto-programmer` を1回打つと、次の順に進む。1件終えると 2 へ戻り、着手できる Issue が無ければ `pollIntervalMinutes` の時間だけ待って見直す。**人間が Ctrl+C で止めるまで終了しない。** 実装中に止めても、その1件の記録を残してから終わる。ただし claude のセッションが続けて失敗したら、カードを空振りで In progress へ送り続けないよう自分で止まる。

| 順  | すること                                                                                                    | 担当                          |
| --- | ----------------------------------------------------------------------------------------------------------- | ----------------------------- |
| 1   | `gh` の認証と `claude` の有無の確認・AI 専用 clone の作成                                                   | preflight                     |
| 2   | Ready かつ `ai-fixable` な open Issue から、着手できる1件を選ぶ                                             | このツール                    |
| 3   | clone を `origin/main` へ戻し、トピックブランチを作り、依存を揃える                                         | このツール                    |
| 4   | 選んだ Issue のカードを「In progress」へ動かす                                                              | このツール                    |
| 5   | Issue から `issue:checked` を外し、clone の中で `claude -p "/issue-check #<番号>"` を起動する               | `.claude/skills/issue-check/` |
| 6   | やる必要があるかと、対応方針がポリシーに合うかを確かめ、判定をラベル・state・本文へ書き戻す                 | `/issue-check`                |
| 7   | Issue のラベルと state を読み、実装へ進むか止めるかを決める                                                 | このツール                    |
| 8   | Issue から前回の `issue:needs-clean-session` を外し、clone の中で `claude -p "/auto-dev <番号>"` を起動する | `.claude/skills/auto-dev/`    |
| 9   | 実装・検証・コミット・push・PR 作成                                                                         | `/auto-dev`                   |
| 10  | push した commit の CI（`ci.workflowFile`）が終わるまで待つ                                                 | このツール                    |
| 11  | CI が落ちていれば、clone の中で `claude -p "/auto-fix-ci <番号> <run ID>"` を起動し、10 へ戻る              | `.claude/skills/auto-fix-ci/` |
| 12  | 落ちた原因を直し、コミット・push する                                                                       | `/auto-fix-ci`                |
| 13  | PR の URL・終了コード・CI の結果を記録ファイルへ1行追記する                                                 | このツール                    |

2 で「着手できる」とは、本文の `## ブロッカー` 節に並ぶ Issue が全部 closed であることを指す。着手できる Issue のうち、タイトル先頭の段番号（`/issue-deps` が書き込む）の小さい順、同じ段なら Issue 番号の小さい順に選ぶ。

7 で止めるのは、`issue:checked` が貼り直されていない（判定が書き戻されていない）とき・`issue:needs-human-decision` が付いたとき・close されたときだけである。`/issue-check` が「方針差し替え」に倒した Issue は、差し替わった本文のまま 8 へ進む。

11 で直させるのは `ci.maxFixAttempts` 回までで、使い切っても落ちていれば Issue にコメントと `issue:needs-clean-session` を残して次へ進む。キャンセルされた run・`ci.runWaitLimitMinutes` 分待っても終わらない run は、差分を直しても通らないので直させない。9 で `/auto-dev` が離脱したときは 10 へ進まない。

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

| キー                          | 意味                                                        | 調べ方                                                                                        |
| ----------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `repository`                  | Issue と PR の相手（`owner/repo`）                          | `gh repo view --json nameWithOwner`                                                           |
| `baseBranch`                  | PR のマージ先。トピックブランチもここから切る               | `gh repo view --json defaultBranchRef`                                                        |
| `board.owner`・`board.number` | GitHub Projects の持ち主と番号                              | `gh project list --owner <owner>`                                                             |
| `board.statusFieldName`       | 進捗を持つフィールドの表記                                  | `gh project field-list <番号> --owner <owner>`                                                |
| `board.readyStatusName`       | 「着手してよい」を表す選択肢の表記                          | 同上                                                                                          |
| `board.inProgressStatusName`  | 「着手中」を表す選択肢の表記                                | 同上                                                                                          |
| `targetIssueLabel`            | 対象にする Issue のラベル                                   | `gh label list`                                                                               |
| `sessionTimeoutMinutes`       | claude セッション1回（Skill 1つぶん）を打ち切るまでの分数   | 長いほうの実装に掛かる時間の上限として決める                                                  |
| `pollIntervalMinutes`         | 着手できる Issue が無かったとき、ボードを見直すまで待つ分数 | 短すぎると `gh project` の呼び出し頻度が上がり、GitHub API のレートリミットに達しやすくなる   |
| `ci.workflowFile`             | push で走り、マージ可否を決めるワークフローのファイル名     | `.github/workflows/` の下のファイル名                                                         |
| `ci.pollIntervalSeconds`      | CI の run の状態を見直す秒数                                | 短すぎると `gh run list` の呼び出し頻度が上がる                                               |
| `ci.runWaitLimitMinutes`      | CI の run 1回が終わるまで待つ上限の分数                     | `needs` で直列に並ぶジョブの `timeout-minutes` の合計（最も長い連なり）に、起動待ちの分を足す |
| `ci.maxFixAttempts`           | CI が落ちたとき、`/auto-fix-ci` に直させる回数の上限        | 使い切っても落ちていれば人間へ回す                                                            |

フィールド ID・選択肢 ID は設定に持たせない。表記から実行時に引き直す。

AI 専用 clone と実行記録は `~/dev/auto-programmer/` の下に置かれる。置き場を変えたいときは、`config.mjs` を編集せず環境変数 `AUTO_PROGRAMMER_HOME` で指定する。

## 実行の記録

Issue 1件につき1行の JSON が `runLogPath` に追記される。端末を閉じた後でも、いつ・どの Issue を・どうなったかを追える。

```bash
tail -3 ~/dev/auto-programmer/runs.jsonl | jq .
```

## 別のリポジトリで使うとき

直すのは次の3か所だけ。

- **`config.mjs`**：上の表の値をその環境のものへ書き換える
- **`package.json`**：`auto-programmer` と `test:scripts` のスクリプトを写す
- **`.claude/skills/auto-dev/`・`.claude/skills/auto-fix-ci/`・`.claude/skills/issue-check/`**：そのリポジトリの `.claude/skills/` へ写す（`/auto-dev`・`/auto-fix-ci` が無いと手順が無い。`/issue-check` は `.claude/agents/issue-auditor-agent/` も要る）

`/auto-dev` は移した先の CLAUDE.md・Policy・hook をそのまま使う。実装の進め方をそのリポジトリに合わせたいときは、Issue 本文の「実装フロー（使用するSkill）」で指定する。

## 止まったとき

| 症状                                                                                               | 意味                                                                                                                                 | 直し方                                                                                                                                              |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 「claude のセッションが … 回続けて失敗しました」                                                   | claude がログイン切れ・利用上限などで動けない                                                                                        | 記録の `issueCheckExitCode`・`issueCheckSignal`・`autoDevExitCode`・`autoDevSignal`・`ciFixExitCode`・`ciFixSignal`・`error` を読んで直し、打ち直す |
| 「候補を引けませんでした」                                                                         | `gh` が失敗したか、ボードの表記が `config.mjs` と食い違っている                                                                      | 続く理由を読んで直す（`pollIntervalMinutes` ごとにやり直す）                                                                                        |
| 「GitHub CLI が未ログインです」                                                                    | `gh auth status` が通らない                                                                                                          | `gh auth login`                                                                                                                                     |
| 「着手できる Issue はありません」                                                                  | Ready に対象ラベル付きの open な Issue が無いか、全部にブロッカーが残っている（ブロッカー節を読めないものも含む）                    | ボードのカードを Ready へ動かす・ブロッカーを片付ける                                                                                               |
| 「#… を飛ばします: リモートに … が残っています」                                                   | 同じ Issue のブランチが前回の実行から残っている                                                                                      | 前回の PR を閉じてブランチを消す（次の巡回で拾われる）                                                                                              |
| 「#… を飛ばします: …」（上記以外）                                                                 | 着手前の準備が落ちた。カードは Ready に残り、毎巡回で試される                                                                        | 理由を読んで直す                                                                                                                                    |
| 「…という選択肢がありません」                                                                      | ボードの表記と `config.mjs` の表記が食い違っている                                                                                   | `gh project field-list` の表示に合わせる                                                                                                            |
| 「claude コマンドが見つかりません」                                                                | Claude Code が入っていない                                                                                                           | Claude Code を入れる                                                                                                                                |
| 「実装へ進みません: /issue-check が人間の判断を要すると判定しました」「… close しました」          | `/issue-check` が人間の判断を要すると判定したか、不要として close した。カードは In progress に残る                                  | Issue のコメントを読む。人間判断なら `/issue-decide` で決めてからカードを Ready へ戻す                                                              |
| 「実装へ進みません: /issue-check が判定を書き戻しませんでした」                                    | 監査は終わったが `issue:checked` が貼り直されていない（判定を読めなかった・`gh` が失敗したなど）                                     | Issue のコメントを読み、必要なら人間が `/issue-check #<番号>` を打ってからカードを Ready へ戻す                                                     |
| 「実装へ進みません: /issue-check のセッションが失敗しました」                                      | 監査の結果が書き戻されたか分からないので、実装へ進まなかった                                                                         | 記録の `issueCheckExitCode`・`issueCheckSignal` を読んで原因を直し、カードを Ready へ戻す                                                           |
| Issue が「In progress」のまま残った                                                                | `/auto-dev`・`/auto-fix-ci` が離脱したか、`ci.maxFixAttempts` 回直させても CI が通らなかった（Issue にコメントとラベルが残っている） | コメントを読み、専用のセッションでその Issue に着手する                                                                                             |
| 同上で、Issue にコメントが無い                                                                     | セッションが打ち切られたか、起動後に落ちた                                                                                           | 記録の `autoDevSignal`・`ciFixSignal`・`error` を読んで原因を直す                                                                                   |
| 「CI: CI の run が … 分以内に終わりませんでした」「CI: CI の run が … で終わったので直させません」 | CI が詰まっているか、run がキャンセルされた。差分を直しても通らないので直させずに次へ進んだ。カードは In progress に残る             | 記録の `ciRuns` の URL で run を見て、再実行するか、専用のセッションでその Issue に着手する                                                         |
