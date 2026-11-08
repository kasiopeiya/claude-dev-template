---
name: perf-report
description: 指定した期間の作業 Issue の週次件数と委譲の度合い、着手から PR が出るまでの時間、PR の差分行数の分布、人間レビューの対象の割合、注記を HTML 1枚にする。経営寄りの読み手へ AI 駆動開発の実績を報告するときに使う。「perf-report」「パフォーマンスレポートを作って」と指示されたとき。
argument-hint: '[--from YYYY-MM-DD] [--to YYYY-MM-DD]（省略すると直近1か月）'
disable-model-invocation: true
---

# パフォーマンスレポート

読み手は経営寄りの人で、このやり方を他のプロジェクトへ広げるかを判断する。ハーネスを改善する人も読む。

## 手順

### 1. HTML を作る

```bash
npm run --silent perf-report -- $ARGUMENTS | npm run --silent perf-report-html
```

`scripts/perf-report.mjs` が数えた JSON で、`scripts/perf-report-html.mjs` がひな形（`assets/report-template.html`）を埋めて HTML を書き、その絶対パスを返す。HTML を手で書かない。文章の指示で書かせると、合意した見た目からずれるためである。

- **失敗したら**：エラーが出て絶対パスが返らないときは、エラーをそのまま伝えて終える。件数を手で数えて補わない（打つたびに数字がぶれるため）
- **置き場**：`tmp/perf-report/{yyyymmdd}-perf-report-{from}-{to}.html`。`.claude/skills/html/design-system/` も同じフォルダへコピーされる（既にあれば上書きしない）。同じ日に同じ期間で打つと、HTML は上書きされる

### 2. 描画を確かめる

`.claude/skills/html/references/pr.md` の「描画を確かめて直す」の手順を、HTML を置いたフォルダで行う。ただし、崩れを見つけても HTML を直さない。直しても、打ち直すと消えるためである。

### 3. 出力先を伝える

HTML の絶対パスを伝える。手順2で崩れを見つけたら、その箇所も添える。

## 載せないもの

工数削減・時間短縮・体感値は、出力先を伝える返事にも書き足さない。1プロジェクトでは対照実験ができず、体感は実測とずれるためである。

リポジトリの中のファイルやフォルダの名前（ポリシー文書・スクリプトのパスなど）は、ひな形に載せない。レポートは開発メンバー以外にも配り、その人たちはリポジトリを開けないためである。
