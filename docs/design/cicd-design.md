# CI/CD パイプライン設計 <!-- omit from toc -->

このリポジトリの CI/CD を変更・レビューする開発者／AI が、**なぜこの構成なのか**を知りたいときに参照する。
何がどの条件で実行されるかは `.github/` 配下のワークフロー定義が正であり、本書はそこから読み取れない全体像と理由を書く。

## 目次 <!-- omit from toc -->

- [基本方針](#基本方針)
- [パイプラインの全体像](#パイプラインの全体像)
- [前提と制約](#前提と制約)
  - [技術的制約](#技術的制約)
  - [組織の制約](#組織の制約)
- [GitHubリポジトリ設定](#githubリポジトリ設定)
- [CI実施内容一覧](#ci実施内容一覧)

> [!NOTE]
> 本ファイルは [design-doc.md](../../.claude/rules/design-doc.md) が定める2本柱（基本方針・構成図）のスケルトン。
> 構成図の小見出しは想定される図の例。実際に描く図に合わせて増減してよい。

## 基本方針

## パイプラインの全体像

<details>
<summary>設計意図</summary>

</details>

## 前提と制約

### 技術的制約

- **自動マージした PR の `Closes #N` は Issue を閉じない**：`pr-ai-triage.yml` の `auto-merge` job は `GITHUB_TOKEN` でマージするので、本文に `Closes #N` があっても元の Issue は open のまま残る。後始末は `scripts/close-issues.mjs` が行い、Auto Programmer（`scripts/auto-programmer/`）が Issue を選ぶ前に毎回呼ぶ
  - 定期実行のワークフローにはしない。常に動く CI ジョブの運用の手間を増やさないため
  - マージに使うトークンを GitHub App や PAT に替えない。認証情報の発行・保管・更新の手間が増えるうえ、それで閉じるようになる保証も無いため
  - GitHub が PR と Issue を結ぶリンク（`closingIssuesReferences`）ではなく、PR 本文の `Closes #N` を読む。本文を書き換えるとリンクが外れることがあるため（#508）

### 組織の制約

## GitHubリポジトリ設定

## CI実施内容一覧
