---
name: git-commit
description: git差分を分析し、フォーマットに従ったコミットを自動作成する。
---

# Git Commit Helper

git の変更内容を分析し、適切なコミットメッセージを生成してユーザーに確認したうえで、コミットを実行するスキルです。サブエージェントを使わず、このスキル内で完結して処理します。

## 本スキルの役割と参照先

> [!IMPORTANT]
> コミットメッセージの内容（なぜを書く・件名フォーマット・`(#issue番号)`・本文の要否）、粒度、ブランチ命名、rebase 禁止といった**ルールはすべて [docs/policy/git-policy.md](../../../docs/policy/git-policy.md) で定義される**。本スキルはそれを**実行する手順だけ**を定義する。ルール本文はここに再掲しない（二重管理を避けるため）。判断に迷ったとき・本スキルの記述とポリシーが食い違うときは、**常に git-policy.md を正とする**。

作業開始前に git-policy.md を読み、以下のセクションを参照しながら進めること：

- 件名・本文の書き方 → 「コミットの書き方」「issue対応時のコミットメッセージ」
- 本文に「なぜ」を書くかの判断 → 「『なぜ』をどこに書くか（本文とissueの使い分け）」
- 分割の基準 → 「コミットの粒度」
- type / ブランチ prefix の語彙 → 「ブランチ命名規則」の表

## 処理フロー

### Phase 1：変更内容の取得

現在の状態を把握する：

```bash
git status --short
git diff --stat
git diff --cached --stat
git diff           # 内容の理解に必要な範囲で
git log --oneline -5
```

ステータス出力の先頭2文字でステージ状態・変更タイプを判定する：

```
M  file.ts      # Modified（ステージ済み）
 M file.ts      # Modified（未ステージ）
A  file.md      # Added（ステージ済み）
?? file.txt     # Untracked
```

### Phase 2：Commit Type の判定

type の語彙は git-policy.md「ブランチ命名規則」の prefix 表（`feat` / `fix` / `refactor` / `chore` / `ci` / `test` / `docs`）に従う。diff から type を推定する手順：

1. テストファイル（`*.test.*`, `*.spec.*`）のみ → `test`
2. `docs/` または `*.md` のみ → `docs`
3. ソースの新規追加（A）による機能拡張 → `feat`
4. ソースの修正（M）によるバグ修正 → `fix`
5. 設定ファイル（`package.json`, `tsconfig.json`, `*.config.*` など）のみ → `chore`
6. 振る舞いを変えない構造変更 → `refactor` / CI・GitHub Actions の変更 → `ci`

A=feat・M=fix はあくまで目安。修正が機能追加のこともあるため、**判断に迷う場合や複数解釈がある場合は AskUserQuestion でユーザーに確認する**。

### Phase 2.5：コミット分割の判定

git-policy.md「コミットの粒度」（無関係なファイルを混ぜない）を実践する。ファイルを `type` × トップレベルディレクトリでグループ化し、**2グループ以上に分かれる場合は分割を提案**する：

- 異なる type の混在（例：`docs` と `feat`）→ type ごとに分割
- 異なるトップレベルディレクトリの混在 → ディレクトリごとに分割
- 同一 type・同一ディレクトリ → 原則1コミット

### Phase 3：メッセージの生成

git-policy.md のルールに従って組み立てる。本スキルが担うのは「ポリシーを適用するための入力収集」である：

1. **件名**：`type: 説明`。説明は変更内容が伝わるよう簡潔に（目安30文字以内）。
2. **issue番号**：紐づく Issue があれば件名末尾に `(#番号)` を付与する。番号はブランチ名等から推定し、**不明な場合はユーザーに確認する**。
3. **本文（なぜ）**：本文を書くかどうかは git-policy.md「『なぜ』をどこに書くか」の表で判断する（issueに背景が十分なら省略可／issueに無い判断をした・issueなしなら理由を本文に書く）。書く場合はコードから読み取れない背景・判断理由を記す。

### Phase 4：ステージング対象の決定

- 対象に含める：ソース・ドキュメント・設定・テストの各変更ファイル。
- **除外して警告表示**：`.env*`, `node_modules/`, `dist/`・`build/`, `.DS_Store`/`Thumbs.db`, `*.log`。
- 既にステージ済みのファイルは対象に含め、確認表示では `✓` を付ける。

### Phase 5：ユーザー確認

コミット実行前に必ずプレビューを表示し、承認を得る：

```
=== Git Commit Preview ===

Commit Type: feat
Message: feat: アカウント同期処理の実装 (#42)

Staged Files (will be committed):
  ✓ src/sync.ts

Unstaged Files (not included):
  - CLAUDE.md (modified)

Warnings (if any):
  ⚠ .env is ignored (environment file)

Continue with commit? [Y/n]
```

分割する場合は各コミットの Type・Message・対象ファイルを順に列挙し、まとめて承認を得る。

### Phase 6：コミット実行

承認後、グループごとに `git add` → `git commit` を実行する。

- 複数コミットの途中で失敗（pre-commit hook 等）した場合、成功済みコミットはロールバックしない。失敗したグループはステージされたまま残し、原因と再実行を促す。
- 完了後 `git log --oneline -n <件数>` で結果を表示する。

## 使用方法

```
/git-commit
```
