---
name: asap
description: 人間が `/asap <Issue番号>` と打ったときだけ、issue-check と実装フローの Skill を飛ばし、レビュー1回きりで、着手から PR まで5分（遅くても8分）で進める。
argument-hint: '<Issue番号>'
disable-model-invocation: true
---

# /asap

Issue番号: $ARGUMENTS

Issue を、急いで PR にする。issue-check と実装フローの Skill を飛ばし、レビューは1回きりにして、実装 → コミット → push → `/pr-body` まで進める。subagent は、差分が線（pr-review-policy の WANT の線。手順3）を超えたときのレビューと `/broken-window-issue` にだけ使う。人間だけが打てる。

引数が無ければ、何もせず Issue 番号が要ることを表示して終了する。

迷ったら速さを優先する。たとえば、実装の書き方が2通りあって決めきれないときは、`AskUserQuestion` で人間に聞かず、完了条件を満たす手数の少ない方で進める。ただし、止まるべき Issue に着手しないことは速さより優先する。止まるべき Issue とは、手順1の `decide-issue-start` が止まる指示を返した Issue をいう。それ以外で、自分の判断で止まることはしない。

## なぜ #1231 を覆してよいか

#1231 は「『issue N 対応して』では issue-check を自動で通す」と決めた。issue-check は行数の見積もりを通す関門で、人間に打たせると手間が増えるからである。

この Skill は、その決定に置いた1つだけの例外である。人間しか打てない（`disable-model-invocation: true`）ので、#682・#1231 が退けた「AI が『小さい』と自分で判定して issue-check やレビューを省く」抜け道にはならない。省くかどうかは、人間が `/asap` を打つたびに決める。文章で「issue N を /asap で対応して」と打つと、この Skill は動かず通常の経路が走る。

引き換えに、issue-check で拾える Issue の不備と、重いレビューで拾える指摘を取りこぼす。人間が速さを選んだ結果として受け入れる。

## 時間の測り方

perf-report と同じく、ボードのカードが In progress に入ってから In Review に移るまでで測る。目標5分、上限8分。

上限を超えても止めずに最後まで進め、かかった時間を最後に報告する。途中で打ち切ると、コミットも push もされない半端な状態が残り、人間の手間が増えるためである。

## 変えること

CLAUDE.md と他の規定を、この Skill の中では次のとおり読み替える。

- **実装フローの Skill を呼ばない**：Issue の「実装フロー（使用するSkill）」にある Skill（`/code-dev`・`/design` など）は、中に再レビューのループと、subagent での CI 実行を持つので、「レビュー1回」と、subagent を使う場面の限定を守れない。代わりに、タスク一覧を直接実装する（手順2）
- **issue-check を通さない**：着手の判定は `--skip-issue-check` 付きの `decide-issue-start` が持つ（#1710）。打ち方は手順1
- **「直接編集したファイルは『直接編集』の Skill でレビューする」を、手順3に置き換える**
- **レビューの回数を、1回に絞る**：[ai-review-gate-policy](../../../docs/policy/ai-review-gate-policy.md) の「最大2回」の範囲に収まる。上限の扱いは手順3
- **手元で `/code-ci`・`/unit-test` を回さない**：push 後の CI（`pipeline.yml`）が型チェックとテストを回し、落ちたら hook（`wake-on-ci-failure`）が `/auto-fix-ci` で直す（#1084）。手元で Bash でテストを打つと時間がかかる

## 変えないこと

- 着手時の `npm run close-issues`・`npm run prune-merged-branches-and-worktrees`・`npm run move-issue-card`。数秒で終わり、`move-issue-card` は時間を測り始める点でもある
- 並行セッションの検出（`/git-commit` の「並行セッションを検出する」）
- 本筋外の課題と人間からの指摘の `/broken-window-issue` での起票。裏で走るので本筋を待たせない
- 不可逆な操作（削除・公開・本番操作）の前の確認
- コミットから push までの手順（`/git-commit`、CLAUDE.md「Issue 作業の共通ルール」の取り込みと `gen:adr-index`）と `/pr-body`。速さに効かず、`/pr-body` が PR を待つ時間（`pipeline.yml` の PR 作成 job の timeout まで）は、急いでも縮まない
- Issue の「対応方針」の採る案と、「今回作らないこと」。方針を決め直さない

## 手順

### 1. 着手する

最初に、次の3つを1回の Bash にまとめて打つ。冒頭の `date` は、最後に報告する所要時間の起点になる。1つが失敗しても作業は続けたいので、`&&` でなく `;` でつなぐ。`<番号>` は引数の Issue 番号に置き換える。

```bash
date +%s; npm run close-issues; npm run prune-merged-branches-and-worktrees; npm run move-issue-card -- <番号>
```

続けて、旗付きで着手の判定を打つ。

```bash
npm run --silent decide-issue-start -- <番号> --skip-issue-check
```

出力の1行目の指示に従う。止まる指示なら、着手せず、理由を人間に伝えて終了する。子を選ぶ指示なら、選んだ子の番号で、旗付きの `decide-issue-start` と `move-issue-card` を打ち直す。この Skill は実装フローの Skill を呼ばないので、Skill の起動直前に打つ機会が無い。打たないと、子のカードが In progress を通らず、時間を測れない。以降の Issue 番号は子の番号に読み替える。

次に、`/git-commit` の「並行セッションを検出する」の手順どおりに並行セッションを数える。worktree を切る条件に当たれば、そこの手順で専用の worktree を切って入ってから編集する。

### 2. 実装する

`gh issue view <番号> --json title,body,labels,state` で本文を読む。state が `OPEN` でなければ、何もせず理由を表示して終了する。

「対応方針」の採る案どおりに、「タスク一覧」を直接実装する。1つ終えるごとに `gh issue edit` でチェックを付ける。

リポジトリに差分が出ない Issue（GitHub 上の操作だけで完了するもの）は、PR を経由しない。「完了条件」を満たしたと確かめて `gh issue close` し、手順5へ進む。

### 3. レビューする

差分と線の決め方は次のとおり。

- 差分：ai-review-gate-policy「差分の取り方」と同じ数え方で、追加と削除の合計。未追跡ファイルの行も含む
- 線：[pr-review-policy](../../../docs/policy/pr-review-policy.md)「見積もりで割る線」の WANT の線。値はこの Skill に書き写さない
- 判定：差分全体の合計で、線を超えるかを決める。行数が線とちょうど同じなら、線以下に数える。超えたら、`.md` とそれ以外の両方が、下の表の「線を超える」を使う。たとえば `.md` の差分が数行でも、ほかのファイルと合わせて線を超えれば、その `.md` も `/doc-review` で見る

種別（`.md`／それ以外）ごとに1つずつ、次のレビューを回す。各レビューには、この Issue で編集したその種別のファイルのパスをすべて引数で渡す。

| 種別     | 線以下               | 線を超える     |
| -------- | -------------------- | -------------- |
| `.md`    | `/quick-doc-review`  | `/doc-review`  |
| それ以外 | `/quick-code-review` | `/code-review` |

線以下のときは、次のとおりにする。

- `.md` 以外は、`/quick-code-review` の対象の列挙に無いファイル（`app/`・`infra/`・`.github/workflows/`・`samples/` など）も、すべて `/quick-code-review` で見る。`app/`・`infra/` を区別しない
- `/quick-code-review` の決まりの照合先は、`.ts`・`.tsx` に `.mjs`・`.js` と同じ Rule を当てる。照合先の無い拡張子（`.yml` など）は N/A にする
- `/quick-doc-review` の項目9（冗長な記述）は飛ばす。`deletion-advocate-agent` を起動しないためである。項目9は書き手が自分で判定すると必ず「要る」と結論するので、自分で判定し直しても意味がない。報告の表の項目9の行には「飛ばした（/asap）」と書く

修正は [review-fix-loop](../../rule-bodies/review-fix-loop.md) の「ループ」に従う。ただし上限は1回で、1回目を上限の回として扱う。指摘は重大度によらず全部直し（残してよい例外は review-fix-loop の扱いのまま）、再レビューせずに手順4へ進む。

### 4. コミットから PR まで

この Issue で編集したファイルだけを `git add <パス>` でステージし、`/git-commit stage` を実行する（件名末尾は `(#<番号>)`）。続けて、CLAUDE.md「Issue 作業の共通ルール」の push 前の手順（デフォルトブランチの取り込みと `npm run gen:adr-index`）を行い、push して、`/pr-body <番号>` を実行する。

### 5. 報告する

PR の URL と、実行したレビュー、更新したタスクを表示する。手順1の `date` との差から、着手からの所要時間を分で報告する（正式な値は perf-report が測る）。上限を超えたときは、その旨も書く。

## 使い方

```
/asap 1711    # Issue 1711 を、issue-check を飛ばして急いで PR にする
```
