---
name: no-issue-check
description: 人間が `/no-issue-check <Issue番号>` と打ったときだけ、「issue N 対応して」の流れから issue-check だけを飛ばす。実装フローの Skill・レビュー・コミットから `/pr-body` までは通常どおり進める。
argument-hint: '<Issue番号>'
disable-model-invocation: true
---

# /no-issue-check

Issue番号: $ARGUMENTS

引数の Issue を、`/issue-check`（着手前の Issue 監査）を通さずに「issue N 対応して」と同じ流れで進める。飛ばすのは監査だけで、ほかの手順は変えない。人間だけが打てる。

引数が無ければ、何もせず Issue 番号が要ることを表示して終了する。効くのは引数の Issue 1件だけで、同じ会話の後の「issue N 対応して」には効かない。

## なぜ #1231 の例外にしてよいか

#1231 は「『issue N 対応して』では issue-check を自動で通す」と決めた。issue-check は行数の見積もりを通す関門で、人間に打たせると手間が増えるからである。

この Skill は、その決定に置いた例外である（もう1つは `/asap`）。人間しか打てない（`disable-model-invocation: true`）ので、#1231 が退けた「AI が自分で判定して issue-check を省く」抜け道にはならない。省くかどうかは、人間が打つたびに決める。文章で「issue N を issue-check なしで対応して」と打つと、この Skill は動かず通常の経路が走る。

引き換えに、issue-check で拾える Issue の不備（不要な Issue・ポリシーに反する方針・大きすぎる Issue）を取りこぼす。人間が監査を省くと選んだ結果として受け入れる。

## 変えること

- **issue-check を通さない**：着手の判定を、`--skip-issue-check` 付きの `decide-issue-start` で打つ（手順2）

## 変えないこと

- 着手時のコマンドと並行セッションの検出（手順1）
- Issue の「実装フロー（使用するSkill）」の Skill を記載順に実行すること。レビューの回数も、各 Skill の規定どおり
- タスク一覧のチェック、本筋外の課題と人間からの指摘の `/broken-window-issue` での起票、不可逆な操作の前の確認
- コミットから push までの手順と `/pr-body`（CLAUDE.md「Issue 作業の共通ルール」）

## 手順

### 1. 着手する

`<番号>` は引数の Issue 番号に置き換える。1つが失敗しても作業は続けたいので、`&&` でなく `;` でつなぐ。

```bash
npm run close-issues; npm run prune-merged-branches-and-worktrees; npm run move-issue-card -- <番号>
```

続けて、`/git-commit` の「並行セッションを検出する」の手順どおりに並行セッションを数える。worktree を切る条件に当たれば、そこの手順で専用の worktree を切って入る。

### 2. 着手を判定する

```bash
npm run --silent decide-issue-start -- <番号> --skip-issue-check
```

出力の1行目の指示に従う。

- **止まる指示**：着手せず、理由を人間に伝えて終了する
- **子を選ぶ指示**：選んだ子の番号で、旗付きの `decide-issue-start` を打ち直す。以降の Issue 番号は子の番号に読み替える

### 3. 実装フローを回す

Issue の「実装フロー（使用するSkill）」の Skill を、手順2の1行目にある実装フローの表の「順」の読み方で実行する。同節が無ければ、CLAUDE.md のとおり `npm run --silent select-flow-skills -- <変更するパス>` の出力で決める。実装フローの Skill の起動直前には、CLAUDE.md「Issue 作業の共通ルール」のとおり着手時のコマンドを打つ。終わったら、確認せずにコミット・push・`/pr-body` まで進める（CLAUDE.md「issue番号だけで開発フローを自動追従する」）。

## 使い方

```
/no-issue-check 1990    # Issue 1990 を、issue-check を飛ばして通常の流れで進める
```
