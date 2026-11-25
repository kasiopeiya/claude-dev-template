---
name: no-issue-check
description: 人間が `/no-issue-check` と打ったときだけ、この会話の「issue N 対応して」の流れから issue-check だけを飛ばす。実装フローの Skill・レビュー・コミットから `/pr-body` までは通常どおり進める。
disable-model-invocation: true
---

# /no-issue-check

この会話では、「issue N 対応して」の流れから `/issue-check`（着手前の Issue 監査）だけを飛ばす。人間だけが打てる。

起動したら、**この会話が終わるまで**下のルールを効かせる。1件の Issue だけで元に戻してはならない。

## なぜ #1231 の例外にしてよいか

#1231 は「『issue N 対応して』では issue-check を自動で通す」と決めた。issue-check は行数の見積もりを通す関門で、人間に打たせると手間が増えるからである。

この Skill は、その決定に置いた例外である。人間しか打てない（`disable-model-invocation: true`）ので、#1231 が退けた「AI が自分で判定して issue-check を省く」抜け道にはならない。省くかどうかは、人間が会話ごとに決める。文章で「issue N を issue-check なしで対応して」と打つと、この Skill は動かず通常の経路が走る。

引き換えに、issue-check で拾える Issue の不備（不要な Issue・ポリシーに反する方針・大きすぎる Issue）を取りこぼす。人間が監査を省くと選んだ結果として受け入れる。

## 変えること

- **issue-check を通さない**：「issue N 対応して」で打つ `decide-issue-start` に、`--skip-issue-check` を付ける

```bash
npm run --silent decide-issue-start -- <番号> --skip-issue-check
```

出力の1行目の指示に従う。子を選ぶ指示なら、選んだ子の番号で旗付きのまま打ち直し、以降の Issue 番号は子の番号に読み替える。

## 変えないこと

- 着手時のコマンドと並行セッションの検出（CLAUDE.md「Issue 作業の共通ルール」）
- Issue の「実装フロー（使用するSkill）」の Skill を記載順に実行すること。レビューの回数も、各 Skill の規定どおり
- タスク一覧のチェック、本筋外の課題と人間からの指摘の `/broken-window-issue` での起票、不可逆な操作の前の確認
- コミットから push までの手順と `/pr-body`（CLAUDE.md「issue番号だけで開発フローを自動追従する」）

## 使い方

```
/no-issue-check                      # 以降の「issue N 対応して」で、issue-check を飛ばす
/no-issue-check issue 1990 対応して  # 作業の指示と一緒に打つ
```
