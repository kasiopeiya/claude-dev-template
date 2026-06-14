---
name: to-plan
description: grill-me での対話や事前調査の結果を Plan ファイルに構造化して書き出す。Plan モードでの調査結果や grill-me の議論を Plan 化したいとき、「to-plan」「plan ファイルにして」と指示されたときに使用する。必須セクション（設計書への影響・設計書更新タスク）を満たした Plan を ~/.claude/plans/ に保存し、続けて /check-plan による監査まで自動で行う。
---

# To Plan

`/grill-me` の対話・Plan モードでの調査結果を、後続の `/check-plan` → `/to-issues` に渡せる **Plan ファイル** に構造化して書き出す。開発フロー（CLAUDE.md）のステップ2に対応する。

## 出力先

`~/.claude/plans/<slug>.md`（Plan モードと同じホームディレクトリの `.claude/plans/`）。

- ディレクトリが無ければ作成する。
- `<slug>` はトピックを表すケバブケース（例: `oauth-session-revocation`）。
- 起点 Issue（フロー0）が会話に登場している場合は `<issue番号>-<slug>.md`（例: `42-oauth-session-revocation.md`）。

## プロセス

### 1. コンテキスト収集

会話に既にある情報（`/grill-me` の対話、Plan モードでの調査結果）を起点にする。引数で Issue 番号・URL・パスが渡された場合は `gh issue view` 等で本文・コメントを取得して読む。

**着手前に必ず** `docs/design-hub.md` と `docs/policy/policy-hub.md` を参照する（CLAUDE.md 必読ルール）。設計書ハブが未作成の場合はその旨を Plan に記録する。

### 2. 影響範囲の調査（不足時のみ）

設計書への影響・コードベースへの影響を判断できるだけの情報が揃っていなければ、コードベースを探索して補う。確定仕様は用語集（`docs/glossary.md`）の語彙を使い、該当領域の ADR（`docs/adr/`）を尊重する。

### 3. Plan ファイルを書き出す

`assets/plan-template.md` の構成に従って Plan を書く。**省略不可の必須セクション:**

- **設計書への影響**: 更新が必要な設計書を列挙する。更新不要なら必ず「更新不要・理由：〇〇」と明記する（空欄・省略禁止）。
- **タスク一覧**: チェックボックス形式。**設計書更新が必要な場合は更新タスクを必ず含める**。

「grill-me で確定した仕様」には決定事項だけでなく、**却下した代替案とその理由**も書く（別セッションでの蒸し返し防止 / `/to-issues` がそのまま転記する）。grill-me 未実施なら「grill-me 未実施」と明記する。

### 4. check-plan を自動実行（シフトレフト）

Plan を書き出したら、続けて `/check-plan <Planパス>` を実行する。必須セクションの充足とコードベース・ドキュメントの影響範囲の網羅を Issue 化前に監査し、不足があれば Plan を修正する。判定基準と報告フォーマットは check-plan スキルに委ねる。
