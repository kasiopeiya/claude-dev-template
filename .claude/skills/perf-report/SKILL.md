---
name: perf-report
description: 指定した期間の作業 Issue の週次件数と委譲の度合い、着手から PR が出るまでの時間、PR の差分行数の分布、人間レビューの対象の割合、注記を HTML 1枚にする。経営寄りの読み手へ AI 駆動開発の実績を報告するときに使う。「perf-report」「実績レポートを作って」と指示されたとき。
argument-hint: '[--from YYYY-MM-DD] [--to YYYY-MM-DD]（省略すると直近1か月）'
disable-model-invocation: true
---

# 実績レポート

読み手は経営寄りの人で、このやり方を他のプロジェクトへ広げるかを判断する。載せる指標は「その数字で読み手の判断が変わるか」で選ぶ。

## 手順

### 1. 集計する

```bash
npm run --silent perf-report -- $ARGUMENTS
```

失敗したら HTML を作らず、エラーをそのまま伝える。件数を手で数えて補わない（打つたびに数字がぶれるため）。以降の数字は、すべてこの JSON の値をそのまま使う。

### 2. HTML を書く

`.claude/skills/html/SKILL.md` の「デザインシステム」「図」の規則で書く。同じ Skill の「基本構成」と目次は使わず、下の順で1枚にする。用語リストは置かない。

- **置き場**：`tmp/perf-report/{yyyymmdd}-perf-report-{from}-{to}.html`。`.claude/skills/html/design-system/` を HTML と同じフォルダへコピーする（既にあれば上書きしない）
- **順番**：見出し → リード文 → 図 → 委譲の度合い → 着手から PR が出るまでの時間 → 変更の小ささ → 人間レビューの対象 → 定義 → 読み方 → 限界

**リード文**には、期間、作業 Issue の件数（`workIssueCount`）、全日そろった週の平均と幅（`fullWeekSummary`）を書く。`fullWeekSummary` が `null` なら、全日そろった週が無いので平均を出せないと書く。全日そろった週とは、月曜から日曜までをすべて数え、今日より前に終わった週をいう。今日を含む週は、まだ数え終えていないので含めない。

**図**は、週ごとの作業 Issue の件数（`weeks[].workIssueCount`）の縦棒を、インライン SVG で本文の幅いっぱいに描く。`svg` の `width` を `100%` にし、右や横に何も並べない。

- 棒の上に件数、棒の下に週の範囲（`weekStart`〜`weekEnd`）を書く
- 全日そろった週（`isFullWeek` が `true`）は黒で塗る
- 全日そろっていない週は、白地に破線の枠で描き、棒の下に数えた範囲（`countedFrom`〜`countedTo`）を添える。どちらの描き方かを `figcaption` で説明し、期間の端で切れた週と今日を含む週が破線になることも書く
- 全日そろった週の平均を、灰色の破線で引いて値を添える。`fullWeekSummary` が `null` なら線を引かない
- 有彩色を使わない

**委譲の度合い**は、作業 Issue を分類した件数（`delegationCounts`）を次の表で示す。件数の合計は `workIssueCount` と一致する。

| 分類     | 件数（`delegationCounts`） | ラベル                                                                 | 定義元                                                |
| -------- | -------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------- |
| AI単独   | `aiOnly`                   | `ai-fixable`（`issue:decided` の有無は問わない）                       | `docs/policy/issue-policy.md`「Issue に付けるラベル」 |
| 共同     | `collaboration`            | `ready-for-human` ＋ `human-ai-collaboration`                          | `docs/policy/issue-policy.md`「Issue に付けるラベル」 |
| 人間単独 | `humanOnly`                | `ready-for-human` のみ                                                 | `docs/policy/issue-policy.md`「Issue に付けるラベル」 |
| 分類なし | `unclassified`             | 上のどれにも当たらない（3択なし、`needs-human-decision` のまま close） | `scripts/perf-report.mjs`                             |

表の下に、次の2文をそのまま載せる。

- Issue を作るまでの相談は含まない
- ラベルは着手前の分類で、実際の作業の記録ではない

`collaboration` が `0` のときは、表の下に「対話で作った成果物がこの期間に無い」とも書く。

**着手から PR が出るまでの時間**は、AI 単独の作業 Issue について、ボードの Status が最初に `In Review` になった時刻と、その直前に `In progress` になった時刻の差を、`aiOnlyTimeToPullRequest` の値で示す。`In Review` は PR が Issue に紐づいた時点である。測っているのは Status の間の時間なので、「AI の作業時間」と呼ばない。

測れた件数（`measuredIssueCount`）／対象の件数（`targetIssueCount`）、中央値（`medianMinutes`）、1時間未満の割合（`underOneHourPercentage`）を本文に書く。`medianMinutes` が `null` なら、中央値と割合と図の代わりに、測れた Issue が無いと書く（注記は載せる）。

図は、帯ごとの件数（`bandCounts`）の縦棒を、インライン SVG で本文の幅いっぱいに描く。有彩色を使わない。棒の上に件数、棒の下に帯の名前を書く。

| 帯        | 件数（`bandCounts`） |
| --------- | -------------------- |
| 5分未満   | `under5Minutes`      |
| 5〜14分   | `from5To14Minutes`   |
| 15〜59分  | `from15To59Minutes`  |
| 1〜8時間  | `from1To8Hours`      |
| 8時間以上 | `atLeast8Hours`      |

- 8時間以上の帯だけ、他の帯の黒塗りと違う描き方（白地に斜線）にし、棒の近くに「作業ではなく停止」と書く
- `figcaption` で棒の読み方を説明し、8時間以上の帯は「エラーや判断待ちで止まっていた時間」と書く

図の下に、次の文をそのまま載せる。最初の文は太字にする。

- **人間が同じ作業にかかる時間との比較ではなく、何倍速いかは言えない**
- 1件は小さく割った Issue で、大きな機能を作る時間ではない
- Issue を作るまでの相談、自動検査、レビュー、マージの時間は含まない
- 失敗してやり直す前の時間は含まないので、その分だけ実際より短く見える
- `In progress` と `In Review` の両方の記録が無い Issue は数えない

**変更の小ささ**は、期間内にマージした PR の差分行数（追加と削除の合計）を、`pullRequestDiffLines` の値で示す。件数の合計は `mergedPullRequestCount` と一致する。

| 帯         | 件数（`bandCounts`） |
| ---------- | -------------------- |
| 50行未満   | `under50`            |
| 50〜199行  | `from50To199`        |
| 200〜300行 | `from200To300`       |
| 300行超    | `over300`            |

表の下に、中央値（`median`）と平均（`average`）を書き、次の2文をそのまま載せる。`median` が `null` なら、中央値と平均と2文の代わりに、期間内にマージした PR が無いと書く。

- 平均は一部の大きな変更に引っ張られるので、中央値を中心に読む
- 小さく回せている事実を示すだけで、有効さの証明ではない

**人間レビューの対象**は、期間内にマージした PR のうち `needs-human-review` が付いた割合を、`humanReviewTargets` の値で示す。全体の割合（`targetPercentage`）と件数（`targetCount`／`mergedPullRequestCount`）を本文に書く。`targetPercentage` が `null` なら、割合と図と注記の代わりに、期間内にマージした PR が無いと書く。

図は、週ごとの件数（`weeks[].humanReviewTargets`）の縦棒を、最初の図と同じ規則（本文の幅いっぱい・有彩色なし・棒の下に週の範囲・全日そろっていない週の破線の枠と数えた範囲）のインライン SVG で描く。

- 棒の高さをマージした PR の件数（`mergedPullRequestCount`）にし、下から対象の件数（`targetCount`）の分を塗る
- 棒の上に `targetCount`／`mergedPullRequestCount` 件と割合（`targetPercentage`）を書く。`mergedPullRequestCount` が `0` の週は棒を描かず、`0件` とだけ書く
- `figcaption` で棒の読み方を説明し、対象の定義元が `docs/policy/pr-review-policy.md`「ラベルとレビュイーの経験でレビュー方針を決める」の表であることを書く

図の下に、次を載せる。

- 対象になった割合で、人間が読んだ割合やかかった時間ではない
- この割合だけでは、レビューがボトルネックかどうかは言えない
- 対象のうち `policy`・`cicd` の PR は `policyOrCicdCount` 件である。プロダクト開発では内訳が変わる
- 対象はルールで決まる。ルールが変わると割合も変わる

**定義**は、作業 Issue を「GitHub で完了（completed）として close された Issue から、次の表のものを除いたもの」と書き、表を置く。週は日本時間の月曜始まりである。

| 除いたもの                                             | 件数（`excludedCounts`） | 定義元                                                                              |
| ------------------------------------------------------ | ------------------------ | ----------------------------------------------------------------------------------- |
| 完了以外の close（見送り・重複）                       | `notCompleted`           | GitHub の close の理由                                                              |
| PR のレビュー通知（bot 名義の `needs-human-review`）   | `reviewNotification`     | `docs/policy/pr-review-policy.md`「ラベルとレビュイーの経験でレビュー方針を決める」 |
| 子を持つ親                                             | `parent`                 | `docs/policy/issue-policy.md`「Issue の階層の形」                                   |
| ルート Issue（`phase`）                                | `rootIssue`              | `docs/policy/issue-policy.md`「Issue に付けるラベル」                               |
| 週次 Issue（`doc-audit-weekly`・`code-policy-weekly`） | `weeklyIssue`            | `docs/policy/issue-policy.md`「Issue に付けるラベル」                               |
| メモ（ラベルが無く、本文が空）                         | `memo`                   | `scripts/perf-report.mjs`                                                           |

**読み方**には、次の2文をそのまま載せる。

- 週ごとの件数は大きくぶれるので、1週の増減で良し悪しを判断しない
- 少ない週は、要件定義など件数に出にくい作業の時期のことがある

**限界**には、次を載せる。

- 1人・1プロジェクトの自己評価である
- `hasProductCode` が `false` のときだけ、次の2文も載せる（`app/`・`infra/` にコードが無く、プロダクトの CI も本番も動いていないため）
  - 中身は仕組みづくりの実績である
  - プロダクトと本番では未検証である

### 3. 描画を確かめる

`.claude/skills/html/references/pr.md` の「描画を確かめて直す」の手順を、HTML を置いたフォルダで行う。

### 4. 出力先を伝える

HTML の絶対パスを伝える。

## 載せないもの

工数削減・時間短縮・体感値は載せない。1プロジェクトでは対照実験ができず、体感は実測とずれるためである。
