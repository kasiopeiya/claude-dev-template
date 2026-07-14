# 静的解析（ESLint / tsconfig）サンプル

`sample/` 直下に置いた静的解析ゲートのサンプル。プロジェクトのコーディング規約（[typescript.md](../.claude/rules/typescript.md) / [cdk.md](../.claude/rules/cdk.md)）を ESLint と tsconfig で自動適用する例を示す。CDK・アプリ双方の TypeScript を対象にする。機械で測れる品質を CI ゲートへ寄せ、LLM レビューを機械で測れない判断に集中させることが狙い。

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
| ⑩   | マジックナンバー禁止（**`src/` のみ**）                               | `no-magic-numbers`                                                          | －         |
| ⑪   | 浮いた Promise・Promise 誤用の禁止                                    | `@typescript-eslint/no-floating-promises` / `no-misused-promises`           | －         |

⑥〜⑨のしきい値は [typescript.md](../.claude/rules/typescript.md) を SSOT とする。⑪は型情報が要るため対象を tsconfig に含まれるソースへ限定し、型サービスを有効化している。

### 較正（過剰ゲート化を避ける）

- **⑩ マジックナンバーは `src/`（アプリロジック）のみ**。CDK はメモリ量・タイムアウト・しきい値など設定値としての数値リテラルが正当なため対象外にする。
- **`require-await` は `warn` 止め**。`async` ポート（`Promise` を返す interface）を満たすための `await` なし `async` 実装（例: インメモリ Repository）を誤検知するため、error にはしない。
- テストコードは期待値の数値リテラルを直書きするのが読みやすいため、⑩の対象から外す。

「プラグインで規約通りに設定できるものはプラグイン、できないものだけ自作ルール」の方針。④のみ該当する標準ルールが無いため自作した（[eslint-rules/awsCdkLibBarrelImport.mjs](eslint-rules/awsCdkLibBarrelImport.mjs)）。⑥の認知的複雑度のみ [`eslint-plugin-sonarjs`](https://github.com/SonarSource/eslint-plugin-sonarjs) を追加している（他は ESLint / typescript-eslint 同梱）。

## tsconfig による型の厳格化

型検査は「最強・最安の評価関数」であり、ESLint と並ぶゲートとして効かせる。`strict` に加えて `noUnusedLocals` / `noUnusedParameters` / `noImplicitReturns` / `noUncheckedIndexedAccess` / `noFallthroughCasesInSwitch` を有効化する。フラグの実体は各 `tsconfig.json`（[src](src/tsconfig.json) / [cdk](cdk/tsconfig.json)）を SSOT とする。

`exactOptionalPropertyTypes` は自前で型を制御できる **`src/` のみ**有効にする。CDK では aws-cdk-lib の optional 多用型（env-agnostic synth で `account` が `undefined` になる等）と衝突し過剰ゲートになるため外す。

### ④ 自作ルールの autofix 範囲

- `import * as s3 from 'aws-cdk-lib/aws-s3'` → `import { aws_s3 as s3 } from 'aws-cdk-lib'` は**自動修正する**（ローカル名 `s3` を保てるため安全）。
- `import { Bucket } from 'aws-cdk-lib/aws-s3'` は**検出のみ**。使用箇所（`Bucket` → `s3.Bucket`）の書き換えを伴い自動修正が非安全なため手動で直す。

## 未使用コード検出（knip）

ESLint の `no-unused-vars`（②）や tsconfig の `noUnusedLocals` は **1 ファイル内**の未使用しか捕まえられない。どこからも import されない export・到達しないファイル・使われない依存という **プロジェクト横断の未使用** は [knip](https://knip.dev) で検出し、AI が残しがちな足場コードをゲートする。設定は [knip.jsonc](knip.jsonc)（ルート・`cdk`・`src` を workspace として一括検査）。

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

`src/` にはクリーンアーキテクチャ構成のサンプルを置いている。ArchUnitTS によるアーキテクチャテストを app コードだけに適用し `cdk/` へ及ぼさないため、`src/` は自前の `package.json` / `tsconfig.json` で TS プロジェクト境界を持つ（テスト本体は issue #17）。リント設定はこのファイル（ルート）に共通化しており `src/` も対象にする。詳細は [src/README.md](src/README.md)。
