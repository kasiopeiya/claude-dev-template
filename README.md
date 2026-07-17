# 静的解析（ESLint / tsconfig）

リポジトリ直下に置いた静的解析ゲートの設定。プロジェクトのコーディング規約（[typescript.md](.claude/rules/typescript.md) / [cdk.md](.claude/rules/cdk.md)）を ESLint と tsconfig で自動適用する。CDK・アプリ双方の TypeScript を対象にする。機械で測れる品質を CI ゲートへ寄せ、LLM レビューを機械で測れない判断に集中させることが狙い。

## 適用している ESLint ルール

| #   | ルール                                                                | 実現手段                                                                    | autofix    |
| --- | --------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------- |
| ①   | クラス・関数の前後に空行を入れる                                      | `@stylistic/padding-line-between-statements`＋`lines-between-class-members` | ✅         |
| ②   | 未使用の変数・引数を検出（optional 引数を含む全引数）                 | `@typescript-eslint/no-unused-vars`（`args: 'all'`）                        | －         |
| ③   | import 順序（標準ライブラリ→サードパーティ→自作、各グループ間に空行） | `eslint-plugin-import` の `import/order`                                    | ✅         |
| ④   | aws-cdk-lib のサービスモジュールは barrel 形式に統一                  | 自作ルール `local/aws-cdk-lib-barrel-import`                                | ✅（一部） |
| ⑤   | `any` を禁止し型システムを使わせる                                    | `@typescript-eslint/no-explicit-any`                                        | －         |
| ⑥   | 複雑度（循環的・認知的とも各 15 まで）                                | `complexity`＋`sonarjs/cognitive-complexity`                                | －         |
| ⑦   | 関数長（50 行まで。コメント・空行は除く）                             | `max-lines-per-function`                                                    | －         |
| ⑧   | 引数数（3 個まで）                                                    | `max-params`                                                                | －         |
| ⑨   | ネスト深さ（2 重まで）                                                | `max-depth`                                                                 | －         |
| ⑩   | マジックナンバー禁止（**`app/` のみ**）                               | `no-magic-numbers`                                                          | －         |
| ⑪   | 浮いた Promise・Promise 誤用の禁止                                    | `@typescript-eslint/no-floating-promises` / `no-misused-promises`           | －         |

⑥〜⑨のしきい値は [typescript.md](../.claude/rules/typescript.md) を SSOT とする。⑪は型情報が要るため対象を tsconfig に含まれるソースへ限定し、型サービスを有効化している。

### 較正（過剰ゲート化を避ける）

- **⑩ マジックナンバーは `app/`（アプリロジック）のみ**。CDK はメモリ量・タイムアウト・しきい値など設定値としての数値リテラルが正当なため対象外にする。
- **`require-await` は `warn` 止め**。`async` ポート（`Promise` を返す interface）を満たすための `await` なし `async` 実装（例: インメモリ Repository）を誤検知するため、error にはしない。
- テストコードは期待値の数値リテラルを直書きするのが読みやすいため、⑩の対象から外す。

「プラグインで規約通りに設定できるものはプラグイン、できないものだけ自作ルール」の方針。④のみ該当する標準ルールが無いため自作した（[eslint-rules/awsCdkLibBarrelImport.mjs](eslint-rules/awsCdkLibBarrelImport.mjs)）。⑥の認知的複雑度のみ [`eslint-plugin-sonarjs`](https://github.com/SonarSource/eslint-plugin-sonarjs) を追加している（他は ESLint / typescript-eslint 同梱）。

## tsconfig による型の厳格化

型検査は「最強・最安の評価関数」であり、ESLint と並ぶゲートとして効かせる。`strict` に加えて `noUnusedLocals` / `noUnusedParameters` / `noImplicitReturns` / `noUncheckedIndexedAccess` / `noFallthroughCasesInSwitch` を有効化する。フラグの実体は各 `tsconfig.json`（[app/backend](app/backend/tsconfig.json) / [infra](infra/tsconfig.json)）を SSOT とする。

`exactOptionalPropertyTypes` は自前で型を制御できる **`app/` のみ**有効にする。CDK では aws-cdk-lib の optional 多用型（env-agnostic synth で `account` が `undefined` になる等）と衝突し過剰ゲートになるため外す。

### ④ 自作ルールの autofix 範囲

- `import * as s3 from 'aws-cdk-lib/aws-s3'` → `import { aws_s3 as s3 } from 'aws-cdk-lib'` は**自動修正する**（ローカル名 `s3` を保てるため安全）。
- `import { Bucket } from 'aws-cdk-lib/aws-s3'` は**検出のみ**。使用箇所（`Bucket` → `s3.Bucket`）の書き換えを伴い自動修正が非安全なため手動で直す。

## 未使用コード検出（knip）

ESLint の `no-unused-vars`（②）や tsconfig の `noUnusedLocals` は **1 ファイル内**の未使用しか捕まえられない。どこからも import されない export・到達しないファイル・使われない依存という **プロジェクト横断の未使用** は [knip](https://knip.dev) で検出し、AI が残しがちな足場コードをゲートする。設定は [knip.jsonc](knip.jsonc)（ルート・`infra`・`app/backend` を workspace として一括検査）。

### 較正（過剰ゲート化を避ける）

import グラフから辿れない参照は knip が未使用と誤検知するため、明示的に登録する。

- **文字列パスで参照されるファイルは `entry` に登録**：Lambda ハンドラ（CDK が `entry: path.join(...)` で参照）・vitest の `snapshotSerializers`。
- **実行時ツールは `ignoreDependencies`**：`tsx`（`cdk.json` の CDK アプリ実行）・`esbuild`（NodejsFunction のバンドルで aws-cdk-lib が内部起動）。

## 使い方

```bash
npm install          # 依存を導入
npm run lint         # 静的解析（違反があれば非ゼロ終了）
npm run lint:fix     # 自動修正込みで実行
npm run test:rule    # 自作ルールの単体テスト（RuleTester）
npm run knip         # 未使用 file/export/dependency を検出（検出があれば非ゼロ終了）
```

`app/backend/` はクリーンアーキテクチャ構成で実装している。ArchUnitTS によるアーキテクチャテストを app コードだけに適用し `infra/` へ及ぼさないため、`app/backend/` は自前の `package.json` / `tsconfig.json` で TS プロジェクト境界を持つ（テスト本体は issue #17）。リント設定はこのファイル（ルート）に共通化しており `app/` も対象にする。詳細は [app/backend/README.md](app/backend/README.md)。

# 変更してはならないパス

以下はハーネスで利用しており、リネーム・移動すると `.claude/hooks`・`.claude/skills`・CI・静的解析設定が壊れるパス。中身の編集や配下への新規ファイル追加は自由。

## docs/ 配下

| パス | 固定である根拠 |
| --- | --- |
| `docs/policy-hub.md` | CLAUDE.md・ほぼ全スキルが起点として直接参照 |
| `docs/policy/`（ディレクトリ＋各ファイル名） | `.claude/hooks/policy-loader.mjs` がこのパスを直接読み込み、front-matter `applies-to` で自動アタッチする。個々のファイル名も多数のスキルから SSOT として直接参照される |
| `docs/design-hub.md` | CLAUDE.md・design/to-plan/check-plan/cdk-imp 等が起点として直接参照 |
| `docs/design/`（ディレクトリ名） | `design-doc-policy.md` の `applies-to`、cdk-review スキルの既定パス（`docs/design/infrastructure-design.md`）が参照。中の個別設計書は自由に追加・更新可 |
| `docs/adr/`, `docs/adr/adr-template.md`, `docs/adr/adr-index.md` | CLAUDE.md・create-adr/decide-tech-stack スキルがファイル名までハードコード参照。一覧表への行追加は自由 |
| `docs/reference/glossary.md`, `docs/reference/non-functional-requirement-items.md` | to-plan・elicit-requirements・quick-issue 等が SSOT として直接参照 |
| `docs/reference/test-terms.md` | `policy-hub.md` の一覧、`test-strategy-policy.md`・`unit-test-policy.md` がテストダブル定義の SSOT として直接参照 |
| `docs/guide/`（ディレクトリ名。例: `directory-structure-guide.md`, `code-review-guide.md`） | decide-tech-stack・code-review スキルが直接参照 |
| `docs/requirements.md` | `requirements-doc-policy.md` の `applies-to`、elicit-requirements/decide-tech-stack/requirements-review スキルの既定パス |

## トップレベル

| パス | 固定である根拠 |
| --- | --- |
| `infra/` | CI（`pipeline.yml`/`dev-destroy.yml`）の working-directory・変更検知、`knip.jsonc` の workspace キー、`eslint.config.mjs` のファイル glob、`cdk-design-policy.md` の `applies-to`、cdk-review スキルが直接ハードコード |
| `app/`, `app/backend/`, `app/frontend/` | 同様に CI・knip・eslint に加え `application-design-policy.md`/`application-logging-policy.md`（`app/**`）、`frontend-design-policy.md`（`app/frontend/**`）が `applies-to` でハードコード |
| `eslint-rules/` | `eslint.config.mjs` が直接 import、ルート `package.json` の `test:rule` スクリプトが参照 |

`infra/`・`app/` は**場所（ディレクトリ名）だけ**固定で、中身（`parameter.ts` の値、`lib/` 配下のスタック/Lambda 実装、`app/backend/domain` 等のサンプルロジック）は自由に差し替えてよい。

## ルート静的解析ゲート設定

| パス | 固定である根拠 |
| --- | --- |
| `eslint.config.mjs` | ESLint ルール定義・自作ルール import 元。CI もこれを実行 |
| `tsconfig.json`（ルート） | ルートの型検査設定 |
| `.prettierrc.js`, `.prettierignore` | フォーマッタ設定 |
| `knip.jsonc` | 未使用コード検出の workspace 定義 |
| `package.json`（ルート） | `scripts`・devDependencies。CI がスクリプト名を直接実行 |

なお `.claude/`・`.github/` はこのセクションの対象外（ハーネス本体として別枠で扱う）。
