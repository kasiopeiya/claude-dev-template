---
name: progress-report
description: 指定した期間に片付けた作業 Issue を人ごとに分け、人ごとの総括を添えた Markdown をターミナルに出す。チームの進捗報告をチャットへそのまま貼るときに使う。「progress-report」「進捗報告を作って」と指示されたとき。
argument-hint: '[--from YYYY-MM-DD] [--to YYYY-MM-DD]（省くと今日までの7日）'
disable-model-invocation: true
---

# 進捗報告

期間の引数: `$ARGUMENTS`

人間だけが打てる。

`/perf-report` との違い：`/perf-report` は経営寄りの読み手に向けた HTML で、人ごとに分けない。この Skill はチームの会議やチャットに貼る Markdown で、人ごとに分ける。

## なぜ一覧をスクリプトに任せるか

AI に Issue を数えさせると、レビュー通知や親 Issue を数えるかが打つたびにぶれ、報告どうしを比べられない。そこで、一覧は `scripts/progress-report.mjs` が出し、AI は総括の文章だけを書く。

## 手順

### 1. 一覧を取る

```bash
npm run --silent progress-report -- $ARGUMENTS
```

- **失敗したら**：標準エラーをそのまま伝えて終える。Issue を手で数えて補わない
- **`workIssueCount` が 0 のとき**：期間内に作業 Issue が無かったことを1行で伝えて終える。このとき JSON は `{"repository":"owner/repo","from":"2020-01-01","to":"2020-01-01","workIssueCount":0,"assigneeSections":[]}` の形になる

JSON の `assigneeSections` は人ごとの欄の配列で、1つの欄は次のキーを持つ。

| キー         | 中身                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------ |
| `assignee`   | ログイン名。assignee の無い Issue の欄は「担当なし」                                       |
| `workIssues` | その人の作業 Issue。1件ごとに `number`・`title`・`body`・`closingPullRequestTitles` を持つ |

### 2. 一覧を並べる

`assigneeSections` を、出てきた順のまま並べる。`assignee` はそのまま1行に書き（`#` は付けない）、`workIssues` は `- #<number> 「<title>」` の1行にする。

- **Issue を足さない・省かない・並べ替えない**：assignee が複数の Issue が、全員の欄に載るのも仕様である
- **`title` は書き換えない**：タイトル先頭の着手順の数字（`3. `・`1〜3. `）は、スクリプトが外してある

### 3. 総括を書く

人ごとに、**3文までの1段落**で総括を書く。総括は一覧の要約なので、Issue を1件ずつ拾わず、主な流れを2〜3個に絞って書く。「行」で数えないのは、Markdown では長い1行も1行に数えられ、長さの上限にならないためである。

材料は、その人の欄の `body` と `closingPullRequestTitles` だけにする。「担当なし」の欄にも、ほかの欄と同じく総括を書く。材料を増やすために `gh` や `git` を打たない。

- ✅ 「/perf-report を、ひな形を埋めるスクリプトと AI の考察で作る形に作り替えた。着手判定と実装フローの Skill 選びをスクリプトに移し、/progress-report を新設した。」（主な流れだけを2文で書いている）- ✅ PR タイトルが「/perf-report に差分行数の分布を足す」なら、「/perf-report に差分行数の分布を足した」と書く
- ❌ 「報告の手間が半分になった」と書く（本文にも PR タイトルにも無い効果を足している）

### 4. 出力する

次の形の Markdown を、コードブロック1つでターミナルに出す。ログイン名・番号は例。

```text
alice
- #11 「進捗報告用のSkillを作成する」
- #12 「...」

（総括）

bob
- #13 「hoge」

（総括）
```

- 期間の見出しと、チーム全体の総括は足さない（足す要望が出たら、Skill を直すかどうかを人間と決める）
