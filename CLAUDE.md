# CLAUDE.md

## 必読ドキュメント

> [!IMPORTANT]
> `docs/accountsyncbatch-readme.md` は accountsyncbatch バッチの全設計書のハブドキュメント。いかなるタスク（実装・調査・レビュー・質問への回答）であっても、作業開始前に必ず最初に参照すること。Lambda設計・インフラ設計・ステートマシン設計・テスト方針・ADR等の個別設計書はすべて `docs/accountsyncbatch-readme.md` からリンクされている。個別設計書を読む前に必ずハブを経由すること。

> [!NOTE]
> 認可情報取り込みバッチ（authorizationimportbatch）のハブは `docs/authorizationimportbatch-readme.md`（準備段階）。バッチ固有のタスクではこちらを参照する。

- 用語の定義：[docs/glossary.md](docs/glossary.md)

## ポリシー（最優先）

> ポリシーとは、人や組織によって判断が分かれやすい事柄に対して「私たちの考える良い〇〇とはこれです」と宣言するものである。AIの出力のブレを小さくし、意図通りに操ることを目的とする。

ポリシーはこのプロジェクトの憲法であり、すべての判断の北極星である。
設計・実装・レビュー・git操作など、何らかのアクションを起こす前に必ず `docs/policy/policy-hub.md` を参照し、該当するポリシードキュメントの指針に従うこと。ポリシーに反する提案・実装・操作は行ってはならない。

### AIへの基本指示

- 回答は日本語
- 本プロジェクトは仕様駆動開発を採用。実装を変更する際は必ず `docs/` 配下の設計書の更新要否を判断すること。更新不要と判断した場合もその理由を明示すること（「更新不要・理由：〇〇」）
- 仕様や設計の判断が難しい場合は積極的にユーザーに確認を求めてください。疑問がある場合はAskUserQuestionツールで質問してください。
- ユーザーとのやり取りを通じて、他の場面でも発生しうる問題が発生した場合や、効率化のノウハウを得た場合は、必ず解答の最後に知見をまとめ、SkillやSubAgent、開発フロー改善の提案をすること
- ライブラリをインストールする際は最新の安定バージョンを必ず使用すること
- ADRを作成・更新した際は `docs/adr/adr-index.md` の一覧テーブルにも必ず反映すること

> [!IMPORTANT]
> Mermaid図（フローチャート・シーケンス図・アーキテクチャ図・アクティビティ図・デプロイ図など）を作成・更新する際は、必ず `/design-doc-mermaid` スキルを使用すること。自前でMermaid記法を書き起こしてはならない。設計書・ドキュメント・回答内で「図を描く」「diagramを作る」「コードから図を起こす」必要が生じた時点で、他の作業に着手する前にこのスキルを呼び出す。

### ドキュメント・コメントの基本方針

コード・コメント・設計書はすべて「現在の仕様」のみを記述する。改定経緯（旧仕様・廃止されたAPI・移植元など）はADR（`docs/adr/`）に集約し、コードや設計書本文には書かない。判断基準：改定経緯を知らない読者が読んで意味が通るか。「旧」「廃止」「移植」「以前」「もともと」「リファクタ」が出てきたらまず削除を検討する。NG/OK例は [.claude/rules/typescript.md](.claude/rules/typescript.md) を参照。

### 開発フロー

基本的に以下の仕様駆動で開発を行う。各段階でスラッシュコマンドを実行する。

0. **起点Issue起票（人間）**：要望・課題の起点となるIssueをGitHub Issuesに起票（スキップする場合もある）
1. **仕様の相談（人間＋AI）**：`/grill-me` — 対話で仕様・設計を詰める（必要ない場合はスキップ）
2. **Plan作成（人間＋AI）**：Planモードでの事前調査、または `/grill-me` の議論を `/to-plan` でPlanファイル化
   - 必須：「設計書への影響」セクション（更新不要なら「更新不要・理由：〇〇」と明記）
   - 必須：タスク一覧に設計書更新タスクを含める（更新不要な場合を除く）
3. **Planチェック（AI）**：`/check-plan` — 必須セクションの充足とコードベース影響範囲の網羅を早期にチェック（シフトレフト）
4. **Issue作成（AI）**：`/to-issues` — Planを実装Issueに分割してGitHub Issuesに登録（0の起点Issueがあれば sub-issue として紐づける）
5. **設計書更新（AI）**：`/design <Issue番号>` — 設計書更新→レビュー→修正までを自律実行
6. **Lambda実装（AI）**：`/code-dev <Issue番号>` — TDD実装→コードレビュー→静的解析/単体テスト→設計書整合性チェックまでを自律実行
7. **CDK実装（AI）**：`/cdk-dev <Issue番号>` — 実装→レビュー→静的解析/snapshotテスト/cdk synth までを自律実行（※CDKはTDD対象外）
8. **コードレビュー（人間）**：開発エディタ上で実装差分（Lambda・CDK）を確認
9. **コミット（人間）**：`/git-commit` でコミット
10. **push・デプロイ・結合テスト（人間→CI自動）**：リモートブランチに push すると CI が dev へ cdk deploy し、結合テストが自動実行

### 実装時の共通ルール

- TDDはアプリケーションコード（`accountsyncbatch/` 配下）でのみ採用。CDKやその他の実装ではTDDを実施しない
- アプリケーションコードは `accountsyncbatch/` ディレクトリ配下に実装する（バッチ追加時はバッチ名のディレクトリを並列に作成する）
- 全てのバッチはデプロイ先が共通のため、インフラコード（CDK）は同じものを使用。ただしStackは分離しデプロイは独立して実施できるようにする。
- 実装作業は指定されたGitHub Issue番号とリンクされたplanファイルに基づいて実施します
- （厳守！）作業はGitHub Issueに記載されている「タスク一覧」を１つずつ確認し、タスクが完了するごとに必ず `gh issue edit` コマンドでGitHub Issueのチェックリストを更新しながら作業をしてください

## 開発ガイドライン

### コーディング規約・技術ルール

言語・フレームワーク別のルールは `.claude/rules/` 配下にあり、Claude Code実行時に自動ロードされる。実装前に必ず参照すること。

- [.claude/rules/typescript.md](.claude/rules/typescript.md) — TypeScript共通ルール（命名・import順序・コメント方針など）
- [.claude/rules/cdk.md](.claude/rules/cdk.md) — CDK実装ルール（Construct選定・import形式・ビルド禁止事項など）

### ディレクトリ構成

最上位構成のみ示す。各バッチ・設計書の詳細はハブドキュメント（「必読ドキュメント」参照）に委ねる。

```text
.
├── cdk/                          # AWS CDK インフラ定義（全バッチ共通・Stackは分離）
├── accountsyncbatch/             # accountsyncbatch バッチの Lambda 関数群（src/ 配下）
├── authorizationimportbatch/     # authorizationimportbatch バッチの Lambda 関数群（準備段階）
├── asset/                        # 結合テスト用アセット（sql/ 初期データ・input_csv/ 入力CSV）
└── docs/                         # 設計書・ドキュメント（ADR・用語集・CI/CD・ポリシー・各バッチ設計）
```

## Agent skills

### Issue tracker

GitHub Issues（`github.com/DX-Platform/pcd-point-bat`）。`gh` CLI を使う。詳細は `docs/agents/issue-tracker.md`。

### Triage labels

5ロール標準語彙（`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`）。詳細は `docs/agents/triage-labels.md`。

### Domain docs

Single-context。ADR は `docs/adr/`、用語集は `docs/glossary.md`。詳細は `docs/agents/domain.md`。



