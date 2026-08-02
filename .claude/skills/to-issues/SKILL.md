---
name: to-issues
description: Break a plan, spec, or PRD into independently-grabbable issues using tracer-bullet vertical slices. Use for "convert a plan into issues", 「issue化して」「issueに分割して」。
---

# To Issues

Break a plan into independently-grabbable issues using vertical slices (tracer bullets).

The issue tracker is GitHub Issues. Use the `gh` CLI, which resolves the repository from the local git remote.

## 貫く原則：コールドスタート再現性

各 Issue は **会話履歴を一切持たない別セッションの実装者** が読む前提で書く。判断基準は一文:

> この Issue だけ読んで、別セッションが**意図と判断を再構築できるか**。ただし陳腐化する実装詳細はコードに委ねる。

「詳細に書く」と「簡潔に保つ」は対立しない。書くべき詳細（目的・WHY、却下した代替案とその理由、前提・制約・スコープ境界、受け入れ基準）と、書かない詳細（具体的なファイルパス・コードスニペット・レイヤーごとの実装手順）を分ける。

## Process

### 1. Gather context

Work from whatever is already in the conversation context. If the user passes an issue reference (issue number, URL, or path) as an argument, fetch it from the issue tracker and read its full body and comments.

### 2. Explore the codebase (optional)

If you have not already explored the codebase, do so to understand the current state of the code. Issue titles and descriptions should use the project's domain glossary vocabulary, and respect ADRs in the area you're touching.

### 3. Draft vertical slices

Break the plan into **tracer bullet** issues. Each issue is a thin vertical slice that cuts through ALL integration layers end-to-end, NOT a horizontal slice of one layer.

Slices may be 'HITL' or 'AFK'. HITL slices require human interaction, such as an architectural decision or a design review. AFK slices can be implemented and merged without human interaction. Prefer AFK over HITL where possible.

<vertical-slice-rules>
- Each slice delivers a narrow but COMPLETE path through every layer (schema, API, UI, tests)
- A completed slice is demoable or verifiable on its own
- Prefer many thin slices over few thick ones
</vertical-slice-rules>

### 4. Quiz the user

Present the proposed breakdown as a numbered list. For each slice, show:

- **Title**: short descriptive name
- **Type**: HITL / AFK
- **ブロッカー**: which other slices (if any) must complete first
- **User stories covered**: which user stories this addresses (if the source material has them)

Ask the user:

- Does the granularity feel right? (too coarse / too fine)
- Are the dependency relationships correct?
- Should any slices be merged or split further?
- Are the correct slices marked as HITL and AFK?

Iterate until the user approves the breakdown.

### 5. Publish the issues to the issue tracker

For each approved slice, publish a new issue to the issue tracker. Use the issue body template below.

Plan の「実装フロー（使用するSkill）」を各 Issue に**必ず転記する**（そのスライスが実際に触れる種別の Skill だけに絞る）。これは「issue NNN 対応して」だけで開発フローを自動追従させるための情報なので、issue 化で**落とさない**こと。Plan に同セクションが無ければ、変更種別から CLAUDE.md「開発フロー」のマッピング（設計書→`/design`、アプリ→`/code-dev`、CDK→`/cdk-dev`）で補って記載する。

Publish issues in dependency order (blockers first) so you can reference real issue identifiers in the 「ブロッカー」 field.

<writing-rules>

**文体**：中学生が一度で追える文で書く。専門用語は使ってよい。読みにくさの原因は用語ではなく言い回しにある。

| ❌ 書かない                  | ✅ こう書く                    |
| ---------------------------- | ------------------------------ |
| その位置づけが実効を持たない | そう書いてあるだけで守られない |
| 変更耐性の最大化を企図する   | 変更に強くしたい               |
| 根拠を取り逃がす             | 使えるはずの理由を見逃す       |
| 担保する・企図する・起因する | 保つ・ねらう・原因である       |

一文に主語と述語は1組まで。長い一文は切る。

**図**：次のどれか1つでも当てはまるときだけ、`/design-doc-mermaid` で図を描いて「作るもの」の直後に埋め込む。当てはまらないなら描かない。

| 発火条件                                                                                  | 例                                                                    |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 登場するファイル・仕組みが3つ以上あり、その参照が一直線でない（分岐・合流・双方向がある） | 複数の Skill が同じ policy を参照し、policy 側が別の Skill を呼び返す |
| 条件で振る舞いが分かれる、またはループする                                                | 失敗時にリトライする処理                                              |
| 状態が移る（未着手→作業中→完了 のような遷移）                                             | Issue ラベルの遷移規則                                                |

自前で Mermaid を書き起こしてはならない（CLAUDE.md）。

</writing-rules>

<issue-template>
## 親Issue

親 Issue への参照。元が既存 Issue だったときだけ書き、無ければセクションごと省く。

## この変更が必要な理由

1文目に「何が困っているか」を言い切る。2文目以降に「放置するとどう損するか」を書く。合計4行以内。実装の詳細（HOW）は書かない。別セッションの実装者が、判断に迷ったとき優先順位を自力で決められる状態を目指す。

## grill-me で確定した仕様

下の表を埋める。**1行1決定・1セル1文**。却下した案も書くと、別セッションでの蒸し返しを防げる。grill-me を実施していない場合は「grill-me 未実施」と書く（セクションごと省かない）。

| 決めたこと | なぜそう決めたか | 却下した案（理由） |
| ---------- | ---------------- | ------------------ |
| 決定1      |                  | 無ければ「なし」   |

## 作るもの

このスライスのエンドツーエンドの振る舞いを4行以内で書く。レイヤーごとの実装手順は書かない。

ファイルパスやコード片はすぐ古くなるので書かない。例外は、文章より正確に決定を表すコード片（状態機械・リデューサ・スキーマ・型）をプロトタイプが生んだときだけ。決定が読み取れる部分だけに切り詰めて貼り、プロトタイプ由来だと一言添える。

## タスク一覧

実装を完了させるために必要なタスクをチェックボックス形式で列挙する。実装者はこのリストを1つずつ確認し、完了ごとに `gh issue edit` でチェックを更新する（CLAUDE.md の厳守ルール）。設計書・`docs/requirements.md`（要件定義）の更新が必要な場合は、その更新タスクも必ず含めること（Plan の「設計書・要件定義への影響」から転記）。

- [ ] タスク1
- [ ] タスク2
- [ ] （必要に応じて）設計書の更新
- [ ] （必要に応じて）requirements.md の更新

## 実装フロー（使用するSkill）

このIssueを実装する際に使う開発フローSkillを実行順に記載する（Planの「実装フロー」から転記。このスライスが触れる種別だけに絞る）。**issue番号だけで開発フローを再現するための情報**。種別→Skillの対応は CLAUDE.md「開発フロー」が正典。

| 順  | 変更種別       | 使用Skill   |
| --- | -------------- | ----------- |
| 1   | 例：アプリ実装 | `/code-dev` |

## 完了条件

どうなったら閉じてよいかを書く。タスクの言い換えではなく、**外から観測できる状態**で書く（例：`npm run lint` が通る）。

- [ ] 条件1

## ブロッカー

先に完了している必要がある Issue への参照。無ければ「なし（すぐ着手できる）」と書く。

</issue-template>

Do NOT close or modify any parent issue.
