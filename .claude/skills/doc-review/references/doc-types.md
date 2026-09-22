# 文書の種別判定のルール

`/doc-review` が Phase 1 で、対象文書の種別と「人間向け文書」かどうかを1回だけ決めるときのルール。決めた結果を全レンズに渡し、レンズには決め直させない（レンズごとに判定すると結果が割れる）。

## 種別の判定順

上から順に当て、最初に当たったもので確定する。

**1. ディレクトリ（最優先・決定論）**：種別は**ディレクトリで一意に決まる**（ディレクトリ構成が SSOT）。パスが以下のディレクトリ配下なら、ファイル名・セクション構造を見ずに確定する。

- `docs/policy/`：POLICY
- `docs/adr/`：ADR
- `docs/reference/`：REFERENCE
- `docs/guide/`：GUIDE
- `docs/design/`：DESIGN
- `docs/project-context/`：GENERAL
- `docs/runbook/`：GUIDE
- `.claude/rules/`：GUIDELINE
- `.claude/skills/`：GUIDELINE
- `.claude/agents/`：GUIDELINE

**例外**：`docs/design/interface-specification.md` は DESIGN として扱わず GENERAL とする。契約の網羅を書く納品用の仕様書であり（`docs/policy/design-doc-policy.md` の例外規定）、設計書特有の観点は対象外になる。

**2. `docs/` 直下の個別ファイル**：

- `docs/policy-hub.md`, `docs/design-hub.md`：HUB

**3. ファイル名（`docs/` サブディレクトリ外のフォールバック）**：README・CLAUDE・`docs/` 外の Markdown など、1・2で確定しないものにだけ当てる。

- `requirements.md`：PRD
- `*-design.md`：DESIGN
- `*architecture*`, `infrastructure*`：ARCHITECTURE
- `implementation-plan.md`：PLAN
- `README.md`, `CLAUDE.md`：GUIDE

**4. セクション構造**：`## ` で始まる見出しを見る。

- 「なぜ」「技術選定」「設計方針」「選定理由」：DESIGN
- 「要件」「ユースケース」「ターゲット」：PRD
- 「システム構成」「アーキテクチャ」「インフラ」：ARCHITECTURE
- 「フェーズ」「Issue」「実装計画」：PLAN

**5. どれにも当たらない**：GENERAL

## 種別の定義

- **PRD**：プロダクト要求定義書
- **ARCHITECTURE**：アーキテクチャ設計書
- **DESIGN**：機能設計書
- **POLICY**：ポリシー（判断基準の宣言）
- **ADR**：アーキテクチャ決定記録
- **PLAN**：実装計画書
- **ISSUE_SPEC**：Issue仕様書
- **GUIDELINE**：開発ガイドライン
- **GUIDE**：ガイド文書
- **REFERENCE**：参照資料（用語集・項目集）
- **HUB**：ハブ／索引文書
- **GENERAL**：汎用ドキュメント

どの観点をどの種別に当てるかは、観点一覧（`review-criteria.md`）の観点名の注記が決める。

## 人間向け文書の判定

`docs/policy/documentation-policy-for-humans.md` の frontmatter `applies-to` を Read し、対象文書のパスがどれかのパターンに当たれば「人間向け文書」とする。当たらなければ、観点一覧の「人間向け文書のみ対象」の観点は対象外になる。
