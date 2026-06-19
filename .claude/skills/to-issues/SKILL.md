---
name: to-issues
description: Break a plan, spec, or PRD into independently-grabbable issues on the project issue tracker using tracer-bullet vertical slices. Use when user wants to convert a plan into issues, create implementation tickets, or break down work into issues.
---

# To Issues

Break a plan into independently-grabbable issues using vertical slices (tracer bullets).

The issue tracker is GitHub Issues (`github.com/DX-Platform/pcd-point-bat`) and triage label vocabulary is defined in `docs/agents/issue-tracker.md` and `docs/agents/triage-labels.md`.

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
- **Blocked by**: which other slices (if any) must complete first
- **User stories covered**: which user stories this addresses (if the source material has them)

Ask the user:

- Does the granularity feel right? (too coarse / too fine)
- Are the dependency relationships correct?
- Should any slices be merged or split further?
- Are the correct slices marked as HITL and AFK?

Iterate until the user approves the breakdown.

### 5. Publish the issues to the issue tracker

For each approved slice, publish a new issue to the issue tracker. Use the issue body template below. These issues are considered ready for AFK agents, so publish them with the correct triage label unless instructed otherwise.

Plan の「実装フロー（使用するSkill）」を各 Issue に**必ず転記する**（そのスライスが実際に触れる種別の Skill だけに絞る）。これは「issue NNN 対応して」だけで開発フローを自動追従させるための情報なので、issue 化で**落とさない**こと。Plan に同セクションが無ければ、変更種別から CLAUDE.md「開発フロー」のマッピング（設計書→`/design`、アプリ→`/code-dev`、CDK→`/cdk-dev`）で補って記載する。

Publish issues in dependency order (blockers first) so you can reference real issue identifiers in the "Blocked by" field.

<issue-template>
## Parent

A reference to the parent issue on the issue tracker (if the source was an existing issue, otherwise omit this section).

## この変更が必要な理由

なぜこのスライスが必要なのかを記述する。解決する課題・ビジネス上の背景・この変更がもたらす価値を書く。実装の詳細（HOW）ではなく、目的（WHY）に焦点を当てること。別セッションの実装者がこの理由を読めば、判断に迷ったときに「何を優先すべきか」を自力で決められる状態を目指す。

## grill-me で確定した仕様

`/grill-me` での対話や事前の仕様検討で**確定した仕様・設計判断**を漏れなく転記する。決定事項だけでなく、検討の結果「採用しなかった案とその理由」も書くと、別セッションでの蒸し返しを防げる。

- 確定した仕様: ...
- 設計判断とその根拠: ...
- 却下した代替案（あれば）: ...

grill-me を実施していない場合は「grill-me 未実施」と明記する（省略しない）。

## What to build

A concise description of this vertical slice. Describe the end-to-end behavior, not layer-by-layer implementation.

Avoid specific file paths or code snippets — they go stale fast. Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it here and note briefly that it came from a prototype. Trim to the decision-rich parts — not a working demo, just the important bits.

## タスク一覧

実装を完了させるために必要なタスクをチェックボックス形式で列挙する。実装者はこのリストを1つずつ確認し、完了ごとに `gh issue edit` でチェックを更新する（CLAUDE.md の厳守ルール）。設計書の更新が必要な場合は、その更新タスクも必ず含めること。

- [ ] タスク1
- [ ] タスク2
- [ ] （必要に応じて）設計書の更新

## 実装フロー（使用するSkill）

このIssueを実装する際に使う開発フローSkillを実行順に記載する（Planの「実装フロー」から転記。このスライスが触れる種別だけに絞る）。**issue番号だけで開発フローを再現するための情報**。種別→Skillの対応は CLAUDE.md「開発フロー」が正典。

| 順 | 変更種別 | 使用Skill |
|---|---|---|
| 1 | 例：アプリ実装（backend/frontend） | `/code-dev` |

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

## Blocked by

- A reference to the blocking ticket (if any)

Or "None - can start immediately" if no blockers.

</issue-template>

Do NOT close or modify any parent issue.
