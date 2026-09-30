# auto-programmer

ボードの Ready に積まれた Issue を1件ずつ拾い、AI に実装させて PR にするツール。

読むのは、**このツールを自分の環境で動かす／別のリポジトリへ持っていく人が、何が起きるかと、どこを直せばよいかを知りたいとき**。

## 何をするか

`npm run auto-programmer` を1回打つと、次の順に進む。1件終えると 2 へ戻り、着手できる Issue が無ければ `pollIntervalMinutes` の時間だけ待って見直す。**人間が Ctrl+C で止めるまで終了しない。** 実装中に止めても、その1件の記録を残してから終わる。ただし claude のセッションが続けて失敗したら、カードを空振りで In progress へ送り続けないよう自分で止まる。

| 順  | すること                                                                                                                                                            | 担当                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 1   | `gh` の認証と `claude` の有無の確認・AI 専用 clone の作成                                                                                                           | preflight                                 |
| 2   | 閉じ損ねた Issue を閉じ、Ready・`ai-fixable`・自分が担当者の open Issue から着手できる1件を選ぶ                                                                     | このツール                                |
| 3   | 未コミットの変更を stash へ退避して clone を `origin/main` へ戻し、トピックブランチを作り、依存を揃える                                                             | このツール                                |
| 4   | 選んだ Issue のカードを「In progress」へ動かす                                                                                                                      | このツール                                |
| 5   | Issue が open な sub-issue を持てば、子を Ready に載せて 14 へ飛ぶ。持たず `issue:checked` も無ければ、clone の中で `claude -p "/issue-check #<番号>"` を起動する   | このツール・`.claude/skills/issue-check/` |
| 6   | やる必要があるかと、対応方針がポリシーに合うかを確かめ、判定をラベル・state・本文へ書き戻す。1つの PR に収まらず割れる Issue は、`/issue-split` で sub-issue に割る | `/issue-check`                            |
| 7   | 6 で open な sub-issue ができていれば、子を Ready に載せる。続けて Issue のラベルと state を読み、子を載せたか止める理由があれば 14 へ飛ぶ                          | このツール                                |
| 8   | Issue から前回の `issue:needs-clean-session` を外し、clone の中で `claude -p "/auto-dev <番号>"` を起動する                                                         | `.claude/skills/auto-dev/`                |
| 9   | 実装・検証・コミット・push・PR 本文の差し替え                                                                                                                       | `/auto-dev`                               |
| 10  | push した commit の CI（`ci.workflowFile`）が終わるまで待つ                                                                                                         | このツール                                |
| 11  | CI が落ちていれば、clone の中で `claude -p "/auto-fix-ci <番号> <run ID>"` を起動し、10 へ戻る                                                                      | `.claude/skills/auto-fix-ci/`             |
| 12  | 落ちた原因を直し、コミット・push する                                                                                                                               | `/auto-fix-ci`                            |
| 13  | CI が通っていれば、カードを「In Review」へ動かす                                                                                                                    | このツール                                |
| 14  | PR の URL・終了コード・CI の結果を記録ファイルへ1行追記する                                                                                                         | このツール                                |

2 で「自分」とは、`gh` にログインしているアカウントを指す。複数人が同時に動かしても、担当者が1人なら同じ Issue を拾う台は1台だけになる。担当者の無い Issue は誰にも拾われないので、カードを Ready へ動かすときに実行する人を担当者にする。1つのアカウントで2台を動かすと、今までどおり同じ Issue を取り合う。

2 で「着手できる」とは、本文の `## ブロッカー` 節に並ぶ Issue が全部 closed であることを指す。着手できる Issue のうち、タイトル先頭の段番号（`/issue-deps` が書き込む）の小さい順、同じ段なら Issue 番号の小さい順に選ぶ。

2 で先に Issue を閉じるのは、自動マージされた PR の `Closes #N` が Issue を閉じないためである（`scripts/close-issues.mjs`）。毎周閉じるので、回している間にマージされた PR の Issue も次の周で閉じ、それをブロッカーに持つ Issue を拾える。閉じられなくても、そのまま Issue を選びに進む。

5 と 7 で「子を Ready に載せる」とは、open な子をボードに載せ、Status を Ready にし、担当者を自分にすることを指す。載せた子は次の周から 2 で拾われる。親は実装せず、カードは In progress のまま残す。子を持つ親を実装すると、子と作業が二重になるためである。

載せるのは、次のどれにも当たらない子だけである。

- **自分以外の担当者がいる**：他人の担当を取り合わない
- **`ai-fixable` が無い・`issue:needs-human-decision` が付いた**：判断待ちの子を「着手してよい」Ready に置かない
- **カードが Todo・Ready 以外の列にある**：着手した後（In progress・In Review・Done）の子を Ready へ戻すと、同じ Issue をもう一度拾う。ボードに無い子は載せる
- **対象リポジトリ（`repository`）の外にある**：2 は対象リポジトリの Issue しか拾わないので、載せても拾われない

5 で `issue:checked` が付いていれば、6 を飛ばして 7 へ進む。監査の後に前提が崩れていれば、9 で `/auto-dev` が離脱する。

7 で実装へ進まないのは、open な sub-issue ができたとき・`issue:checked` が貼られていない（判定が書き戻されていない）とき・`issue:needs-human-decision` が付いたとき・close されたときだけである。`/issue-check` が「方針差し替え」に倒した Issue は、差し替わった本文のまま 8 へ進む。

11 で直させるのは `ci.maxFixAttempts` 回までで、使い切っても落ちていれば Issue にコメントと `issue:needs-clean-session` を残して次へ進む。キャンセルされた run・`ci.runWaitLimitMinutes` 分待っても終わらない run は、差分を直しても通らないので直させない。9 で `/auto-dev` が離脱したときは 10 へ進まない。

AI が触るのは **AI 専用 clone の中だけ**で、人間の作業ツリーには一切触れない。実行をローカルにしているのは、hook・Policy・SubAgent を含むこのリポジトリのハーネスがそのまま動き、実行時間の上限も無いためである。Projects の読み書きも、ローカルの `gh auth` をそのまま使えるため追加の認証情報を要しない。

## 週次スクリプトが Issue を供給する

2 で拾う `ai-fixable` の Issue の一部は、週次スクリプトが人手を介さず自動起票したものである。Policy・Rule を変えたときに違反になった既存コードは、コードに差分が出ないので通常のレビューに掛からない。それを拾う専用の週次チェックが2本ある。

| スクリプト                                 | 対象                                                               | 起票ラベル               |
| ------------------------------------------ | ------------------------------------------------------------------ | ------------------------ |
| `scripts/doc-consistency-weekly-issue.mjs` | `docs/` 全体（`/doc-consistency`）                                 | `doc-consistency-weekly` |
| `scripts/code-policy-weekly-issue.mjs`     | `app/`（`/code-review` の「決まりどおりか」「設計の形」の2レンズ） | `code-policy-weekly`     |

`scripts/doc-consistency-weekly-issue.mjs` の設計判断：

- **起票だけを GitHub Actions（`doc-consistency-weekly.yml`）が行い、実行そのものは人間か Auto Programmer が行う**：このテンプレートは、GitHub Actions で Claude Code を使えないプロジェクトへの配布も前提にしている。実行そのものを Actions に持たせると、そうしたプロジェクトでは仕組みごと動かない。
- **専用ラベル（`doc-consistency-weekly`）が付いた open な Issue が既にあれば起票しない**：処理待ちの週次 Issue は1件で足りる。起点を前回処理以降の変更に絞れば、処理が1週遅れても次回でその分を追いつけるため、未処理のまま複数積み上げる必要が無い。
- **起点は、実行結果コメントが付いた直近の週次 Issue の HEAD SHA から今回の HEAD までに変わった `docs/**/*.md` にする**：2文書間の重複・矛盾は、どちらかが変わったときにしか生まれない。最初に1回全体を見て、以後の変更を途切れずに起点へつなげれば、すべての組み合わせを一度は見たことになる。該当する週次 Issue が無い、または SHA を読み取れない場合だけ、これまでどおり `docs/` 全体を対象にする。

`scripts/code-policy-weekly-issue.mjs` の設計判断：

- **docs 用の週次 Issue とは別の Issue・別ラベルにする**：1つの Issue に両方載せると、どちらかが未処理のまま残ったとき「open なら起票しない」という決まり（両スクリプト共通）で両方のチェックが止まる。ラベルと Issue を分ければ、一方の遅延がもう一方を妨げない。
- **起点を計算せず、毎週 `app/` 全体を対象にする**：docs 用は前回処理以降の差分に絞るが、これは差分計算の実装コスト（処理済み Issue の探索・HEAD SHA 記録・読み戻し）と引き換えに、文書数が増えても1回あたりのチェック量を抑える対策である。コード側の対象は当面小規模で、差分計算を持たなくても週1回全体を見るコストが見合う。実測の所要時間が閾値を超えたら、差分計算への切り替えを検討する。
- **`samples/` は対象にしない**：参照実装で AI が書き換えられない（リポジトリルートの README「変更してはならないパス」）ため、対象に含めても指摘を直せない。
- **レンズは「決まりどおりか」「設計の形」の2本に絞る**：重複コード（SSoT違反）・単一責任・アプリ設計ポリシー準拠は「設計の形」レンズの担当で、「決まりどおりか」には含まれない。バグ探し・セキュリティ・テストの3レンズは対象外にする。既存コードの潜在バグ・テストの穴を狙う観点は、Policy 変更と無関係に前週と同じ指摘を繰り返しやすいためである。

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

| キー                          | 意味                                                           | 調べ方                                                                                        |
| ----------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `repository`                  | Issue と PR の相手（`owner/repo`）                             | `gh repo view --json nameWithOwner`                                                           |
| `baseBranch`                  | PR のマージ先。トピックブランチもここから切る                  | `gh repo view --json defaultBranchRef`                                                        |
| `board.owner`・`board.number` | GitHub Projects の持ち主と番号                                 | `gh project list --owner <owner>`                                                             |
| `board.statusFieldName`       | 進捗を持つフィールドの表記                                     | `gh project field-list <番号> --owner <owner>`                                                |
| `board.todoStatusName`        | 積まれただけで、まだ着手待ちにしていないことを表す選択肢の表記 | 同上                                                                                          |
| `board.readyStatusName`       | 「着手してよい」を表す選択肢の表記                             | 同上                                                                                          |
| `board.inProgressStatusName`  | 「着手中」を表す選択肢の表記                                   | 同上                                                                                          |
| `board.inReviewStatusName`    | 「CI が通り、レビューしてよい」を表す選択肢の表記              | 同上                                                                                          |
| `targetIssueLabel`            | 対象にする Issue のラベル                                      | `gh label list`                                                                               |
| `sessionTimeoutMinutes`       | claude セッション1回（Skill 1つぶん）を打ち切るまでの分数      | 長いほうの実装に掛かる時間の上限として決める                                                  |
| `pollIntervalMinutes`         | 着手できる Issue が無かったとき、ボードを見直すまで待つ分数    | 短すぎると `gh project` の呼び出し頻度が上がり、GitHub API のレートリミットに達しやすくなる   |
| `ci.workflowFile`             | push で走り、マージ可否を決めるワークフローのファイル名        | `.github/workflows/` の下のファイル名                                                         |
| `ci.pollIntervalSeconds`      | CI の run の状態を見直す秒数                                   | 短すぎると `gh run list` の呼び出し頻度が上がる                                               |
| `ci.runWaitLimitMinutes`      | CI の run 1回が終わるまで待つ上限の分数                        | `needs` で直列に並ぶジョブの `timeout-minutes` の合計（最も長い連なり）に、起動待ちの分を足す |
| `ci.maxFixAttempts`           | CI が落ちたとき、`/auto-fix-ci` に直させる回数の上限           | 使い切っても落ちていれば人間へ回す                                                            |

フィールド ID・選択肢 ID は設定に持たせない。表記から実行時に引き直す。

`sessionTimeoutMinutes` は壁時計（wall-clock）で数える。OS がアイドルスリープすると、寝ていた時間もここに数えられ、無人セッションが実際より早く打ち切られる。`index.mjs` は起動直後にこれを防ぐコマンド（macOS は `caffeinate`、Windows は同梱の `sleepGuard.ps1`）を起動し続けるが、ノートPCの蓋を閉じたことによるスリープ（クラムシェルスリープ）までは止められない。実行中は蓋を閉じないか、外部ディスプレイに繋いでおくこと。Linux は `CLOCK_MONOTONIC` がサスペンド中に止まるため、この問題自体が起きず、何もしない。

AI 専用 clone と実行記録は `~/dev/auto-programmer/` の下に置かれる。置き場を変えたいときは、`config.mjs` を編集せず環境変数 `AUTO_PROGRAMMER_HOME` で指定する。

## 画面の読み方

このツール自身が出す行には、どれも時刻とレベル記号が付く。記号の付かない行は、起動した `claude` セッション・`gh`・`npm` がそのまま流している出力である。

| 記号 | 意味                               | 行き先 |
| ---- | ---------------------------------- | ------ |
| ℹ    | 進行中の出来事                     | stdout |
| ✓    | うまくいった（1件の締め）          | stdout |
| ⚠    | 処理は続くが、人間に見てほしいこと | stderr |
| ✗    | 異常                               | stderr |
| ⏳   | 待っている間の状況                 | stdout |

Issue 1件の始まりには `── #123 タイトル ──` の区切りバナーが出る。claude のセッションが流す大量の出力の中から、このツール自身の話に戻った場所をここで見つける。1件の終わりには、所要時間・CI の結果・PR の URL・記録先がまとめて出る。

色は端末に直接出すときだけ付く。ファイルへリダイレクトしたときと、`NO_COLOR=1` を付けたときは自動で落ちる。

## 待っている間の表示

着手できる Issue が無い間と、push した commit の CI を待っている間は、⏳ の行だけが表示される。この行は、対話的な端末で直接見ているとき（TTY）と、`npm run auto-programmer 2>&1 | tee` のようにファイルやパイプへ流したとき（非TTY）とで見え方が変わる。

| 場面                      | TTY                           | 非TTY                                                 |
| ------------------------- | ----------------------------- | ----------------------------------------------------- |
| 着手できる Issue が無い間 | 1行がその場で書き換わり続ける | 見直すたび（`pollIntervalMinutes` ごと）に1行追記する |
| CI を待っている間         | 1行がその場で書き換わり続ける | 5分ごとに1行追記する                                  |

Issue を見つけた・close した・異常が起きたなど状況が変わったときは、通常の行として追記される。TTY ではその直前に ⏳ の行が消え、非TTY ではそれまでの ⏳ の行が履歴として残ったまま次の行が続く。

## 実行の記録

Issue 1件につき1行の JSON が `runLogPath` に追記される。端末を閉じた後でも、いつ・どの Issue を・どうなったかを追える。

```bash
tail -3 ~/dev/auto-programmer/runs.jsonl | jq .
```

## 別のリポジトリで使うとき

直すのは次の3か所だけ。

- **`config.mjs`**：上の表の値をその環境のものへ書き換える
- **`package.json`**：`auto-programmer` と `test:scripts` のスクリプトを写す
- **`.claude/skills/auto-dev/`・`.claude/skills/auto-fix-ci/`・`.claude/skills/issue-check/`**：そのリポジトリの `.claude/skills/` へ写す（`/auto-dev`・`/auto-fix-ci` が無いと手順が無い。`/issue-check` は `.claude/agents/issue-auditor-agent/` と、割るときに使う `.claude/skills/issue-split/` も要る。`/issue-split` は正典として `.claude/skills/to-issues/`・`.claude/skills/quick-issue/` を参照するので、これも写す）

`/auto-dev` は移した先の CLAUDE.md・Policy・hook をそのまま使う。実装の進め方をそのリポジトリに合わせたいときは、Issue 本文の「実装フロー（使用するSkill）」で指定する。

## 止まったとき

| 症状                                                                                               | 意味                                                                                                                                 | 直し方                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 「claude のセッションが … 回続けて失敗しました」                                                   | claude がログイン切れ・利用上限などで動けない                                                                                        | 記録の `issueCheckExitCode`・`issueCheckSignal`・`autoDevExitCode`・`autoDevSignal`・`ciFixExitCode`・`ciFixSignal`・`error`・`errorStack` を読んで直し、打ち直す                                             |
| 「候補を引けませんでした」                                                                         | `gh` が失敗したか、ボードの表記が `config.mjs` と食い違っている                                                                      | 続く理由を読んで直す（`pollIntervalMinutes` ごとにやり直す）                                                                                                                                                  |
| 「GitHub CLI が未ログインです」                                                                    | `gh auth status` が通らない                                                                                                          | `gh auth login`                                                                                                                                                                                               |
| 「待機中（着手できる Issue なし）」                                                                | Ready に対象ラベル付きで自分が担当者の open な Issue が無いか、全部にブロッカーが残っている（ブロッカー節を読めないものも含む）      | ボードのカードを Ready へ動かして自分を担当者にする・ブロッカーを片付ける                                                                                                                                     |
| 「#… を飛ばします: リモートに … が残っています」                                                   | 同じ Issue のブランチが前回の実行から残っている                                                                                      | 前回の PR を閉じてブランチを消す（次の巡回で拾われる）                                                                                                                                                        |
| 「#… を飛ばします: …」（上記以外）                                                                 | 着手前の準備が落ちた。カードは Ready に残り、毎巡回で試される                                                                        | 理由を読んで直す                                                                                                                                                                                              |
| 「…という選択肢がありません」                                                                      | ボードの表記と `config.mjs` の表記が食い違っている                                                                                   | `gh project field-list` の表示に合わせる                                                                                                                                                                      |
| 「claude コマンドが見つかりません」                                                                | Claude Code が入っていない                                                                                                           | Claude Code を入れる                                                                                                                                                                                          |
| 「実装へ進みません: /issue-check が人間の判断を要すると判定しました」「… close しました」          | `/issue-check` が人間の判断を要すると判定したか、不要として close した。カードは In progress に残る                                  | Issue のコメントを読む。人間判断なら `/issue-decide` で決めてからカードを Ready へ戻す                                                                                                                        |
| 同上（人間判断）で、Issue のコメントが分割の失敗を伝えている                                       | `/issue-check` が割ろうとしたが、子の紐付けか親の作り替えに失敗したので、親を人間判断にした。カードは In progress に残る             | コメントに並ぶ子を手で紐付け直すか閉じ、`issue:needs-human-decision` を外して `ai-fixable` に戻してから、カードを Ready へ戻す。`/issue-decide` は boy-scout しか一覧せず、紐付けの修復も担わないので使わない |
| 「実装へ進みません: /issue-check が判定を書き戻しませんでした」                                    | 監査は終わったが `issue:checked` が貼られていない（判定を読めなかった・`gh` が失敗したなど）                                         | Issue のコメントを読み、必要なら人間が `/issue-check #<番号>` を打ってからカードを Ready へ戻す                                                                                                               |
| 「実装せず子へ引き継ぎます: open な sub-issue を … 件持ちます。Ready に載せた子は 0 件です」       | 親を実装せずに止めたが、載せられる子が無かった（open な子がどれも、載せない条件に当たった）。親のカードは In progress に残る         | 子の担当者・ラベル・カードの Status を見て、載せなかった理由が正しいかを確かめる                                                                                                                              |
| 「実装せず子へ引き継ぎます: open な sub-issue を … 件持ちます」（上記以外）                        | umbrella（子への入口）になった親。子を Ready に載せて引き継いだ。親のカードは、子が全部 close されるまで In progress に残る          | 対処は不要                                                                                                                                                                                                    |
| 「実装へ進みません: /issue-check のセッションが失敗しました」                                      | 監査の結果が書き戻されたか分からないので、実装へ進まなかった                                                                         | 記録の `issueCheckExitCode`・`issueCheckSignal` を読んで原因を直し、カードを Ready へ戻す                                                                                                                     |
| Issue が「In progress」のまま残った                                                                | `/auto-dev`・`/auto-fix-ci` が離脱したか、`ci.maxFixAttempts` 回直させても CI が通らなかった（Issue にコメントとラベルが残っている） | コメントを読み、専用のセッションでその Issue に着手する                                                                                                                                                       |
| 同上で、Issue にコメントが無い                                                                     | セッションが打ち切られたか、起動後に落ちた                                                                                           | 記録の `autoDevSignal`・`ciFixSignal`・`error`・`errorStack` を読んで原因を直す                                                                                                                               |
| 「#… の処理が落ちました: …」                                                                       | 着手中へ動かした後の処理で例外が出た。カードは In progress に残る                                                                    | 続く1行の理由を読む。足りなければ記録の `errorStack` を読む                                                                                                                                                   |
| 途中まで実装したはずの変更が clone から消えた                                                      | セッションが commit より前に落ち、次の巡回が clone を `origin/main` へ戻す前に未コミットの変更を stash へ退避した                    | clone の中で `git stash list` を開き、`auto-programmer: <ブランチ名> の未コミット変更` を探して、そのトピックブランチの上で `git stash apply stash@{<番号>}` する                                             |
| 「CI: CI の run が … 分以内に終わりませんでした」「CI: CI の run が … で終わったので直させません」 | CI が詰まっているか、run がキャンセルされた。直させずに次へ進んだ。カードは In progress に残る                                       | 記録の `ciRuns` の URL で run を見て、再実行するか、専用のセッションでその Issue に着手する                                                                                                                   |
| 「CI: CI が通りました。カードを In Review へ動かせませんでした: …」                                | PR はでき CI も通ったが、ボードの表記が `config.mjs` と食い違っているか `gh` が失敗した。カードは In progress に残る                 | 理由を読んで直し、カードを手で In Review へ動かす                                                                                                                                                             |
