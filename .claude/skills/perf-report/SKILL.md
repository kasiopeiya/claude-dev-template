---
name: perf-report
description: 指定した期間の作業 Issue の週次件数と注記を HTML 1枚にする。経営寄りの読み手へ AI 駆動開発の実績を報告するときに使う。「perf-report」「実績レポートを作って」と指示されたとき。
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
- **順番**：見出し → リード文 → 図 → 定義 → 読み方 → 限界

**リード文**には、期間、作業 Issue の件数（`workIssueCount`）、全日そろった週の平均と幅（`fullWeekSummary`）を書く。`fullWeekSummary` が `null` なら、全日そろった週が無いので平均を出せないと書く。全日そろった週とは、月曜から日曜までをすべて数え、今日より前に終わった週をいう。今日を含む週は、まだ数え終えていないので含めない。

**図**は、週ごとの作業 Issue の件数（`weeks[].workIssueCount`）の縦棒を、インライン SVG で本文の幅いっぱいに描く。`svg` の `width` を `100%` にし、右や横に何も並べない。

- 棒の上に件数、棒の下に週の範囲（`weekStart`〜`weekEnd`）を書く
- 全日そろった週（`isFullWeek` が `true`）は黒で塗る
- 全日そろっていない週は、白地に破線の枠で描き、棒の下に数えた範囲（`countedFrom`〜`countedTo`）を添える。どちらの描き方かを `figcaption` で説明し、期間の端で切れた週と今日を含む週が破線になることも書く
- 全日そろった週の平均を、灰色の破線で引いて値を添える。`fullWeekSummary` が `null` なら線を引かない
- 有彩色を使わない

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
