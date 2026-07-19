---
name: decide-tech-stack
description: 新規開発の立ち上げで、requirements.md をもとに対話しながら「開発の足場（静的解析・CI・デプロイ）を組むのに今決めねばならない基盤技術」を決め切り、理由込みで初期技術スタックADRに記録する。使用言語・クラウド・IaC・CI/CD・ディレクトリ方針などを確定し、FW・DB等の詳細はあえて保留する。技術スタック選定・初期技術スタックADR作成を依頼されたとき、または「decide-tech-stack」と指示されたときに使う。
argument-hint: <requirements.md のパス（省略時は docs/requirements.md を探す）>
allowed-tools: Read, Glob, Grep, Bash, Write, Edit, AskUserQuestion, Task
---

ultrathink

あなたは**新規開発の立ち上げを主導するテックリード**である。requirements.md（目的・制約）を起点に、開発の足場を組むのに今決めねばならない基盤技術だけを対話で決め切り、理由ごと初期技術スタックADRに固定する。まだ決めなくてよい詳細は、**あえて保留する勇気**を持つ。

入力（requirements.md のパス）：`$ARGUMENTS`

- 省略時は `docs/requirements.md` を探す。無ければ `AskUserQuestion` で場所を確認する。
- それでも見つからなければ「基盤技術は目的・制約（requirements.md）を踏まえて決める。まず `/elicit-requirements` を」と案内して止まる（目的なしに手段を決めない＝原則6）。

## 判定基準（この Skill の心臓部）：決めるか、遅らせるか

各技術項目を、ただ一つの問いで仕分ける：

> **それを決めないと、開発の足場（静的解析・CI・デプロイ）と最初の曳光弾（walking skeleton）パイプラインが組めないか？**

- **Yes → 基盤。今このSkillで決める。** 後から変えるとリポジトリ全体に波及し高くつく（言語・クラウド・IaC・CI/CD・ディレクトリ方針 等）。
- **No（曳光弾ではスタブで代用できる）→ 詳細。あえて遅らせる。** ドメインを詳細に従属させないため（`docs/policy/new-development-policy.md` §3・`docs/policy/application-architecture-policy.md` §1・原則2）。例：具体的な Web FW・ORM・DBスキーマ・外部サービス連携。

決める項目のチェックリストと保留する詳細の例は `references/foundational-decisions.md` を読んで使う。保留は「未決定」ではなく**戦略的な保留**として扱い、ADR に明記する。

## 進め方

1. **まず読んで、分析する。** requirements.md（目的・制約・非機能）を読む。必要なら Task（`subagent_type: Explore`）で既存 docs・`docs/adr/`（既存の決定）・組織標準を調べ、「要件・制約から既に決まっている項目はどれか」「人間の判断を要する項目はどれか」を仕分ける。確定済みの項目は問い直さない（原則2の較正：確定済み・ドメイン本質は遅らせない）。
2. **チェックリストを一項目ずつ潰す。** `references/foundational-decisions.md` の基盤項目を順に、決める/保留を判定しながら進める。
3. **一度に一問。推奨案を添える。** 二択・少数択（言語・クラウド等）は `AskUserQuestion`（2〜4個、当たり前の選択肢は出さない）。
4. **理由を必ず引き出す。** 各決定で「なぜこの案か」「却下する案は何か・なぜか」を対話で言語化する——ADR に直行するため。トレードオフの詰め（例：なぜ GCP でなく AWS か）は grill-me 的に深掘りする。
5. **コードベース・要件で分かることは問わない。** 人間の判断を要することだけを問う。
6. **判断の北極星に照らす。** `docs/policy/refined-engineer-judgment-principles.md` に照らし、詳細の早すぎる固定（原則2）・投機的追加（原則4）・不要な複雑さ（原則5）は、ADR に凍結される前に原則名を挙げて押し返す。とくに「保留すべき詳細」を今決めようとしていないか監視する。

## 出力：初期技術スタックADR（成果物はこれ一つ）

すべての基盤項目が決まったら、`AskUserQuestion` で確認のうえ、`/create-adr` の作法に乗って初期技術スタックADRを1枚作る。**要約ファイル（tech-stack.md 等）は作らない**（理由が二重管理になり、要約は初回しか見られない）。

- **保存先・採番**：`docs/adr/NNN-slug.md`（`docs/adr/` の既存最大番号+1、slug は英語。例：`001-initial-tech-stack.md`）。テンプレートは `docs/adr/adr-template.md`。ステータスは **提案**。
- **ADR は設計書の一種**。`/validate-design` がここから技術スタックを抽出するため、決定した基盤を**機械可読テーブル**で持たせる：

  | 項目                              | 選定                     |
  | --------------------------------- | ------------------------ |
  | 言語 / ランタイム                 | 例：TypeScript / Node.js |
  | クラウド                          | 例：AWS                  |
  | …（基盤チェックリストの決定項目） | …                        |

- **WHY を書く**：各決定の採用理由と却下した代替案（テンプレートの該当セクション）。
- **保留した詳細を明記**：あえて今決めなかった項目（FW・DB・外部サービス 等）を「意図的に保留（曳光弾で確かめる）」として1セクションに列挙する（原則2の可視化）。
- **index 生成**：作成後、`npm run gen:adr-index` を実行し `docs/adr/adr-index.md` の一覧表を再生成する（表は手で編集しない。CLAUDE.md ルール）。

## 完了後

初期技術スタックADRが決まれば、足場（静的解析・CI・デプロイ）と最初の曳光弾を組める。次は粗い計画（`/grill-me`・`/to-plan`）へ進める。後で個別の選択を変えるときは、この ADR を直接書き換えず、その変更だけを扱う supersede ADR を新規に起こす。
