# 静的解析（ESLint）サンプル

`sample/` 直下に置いた ESLint 設定のサンプル。プロジェクトのコーディング規約（[typescript.md](../.claude/rules/typescript.md) / [cdk.md](../.claude/rules/cdk.md)）を静的解析で自動適用する例を示す。CDK・アプリ双方の TypeScript を対象にする。

## 適用しているルール

| #   | ルール                                                                | 実現手段                                                                    | autofix    |
| --- | --------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------- |
| ①   | クラス・関数の前後に空行を入れる                                      | `@stylistic/padding-line-between-statements`＋`lines-between-class-members` | ✅         |
| ②   | 未使用の引数を検出（optional 引数を含む全引数）                       | `@typescript-eslint/no-unused-vars`（`args: 'all'`）                        | －         |
| ③   | import 順序（標準ライブラリ→サードパーティ→自作、各グループ間に空行） | `eslint-plugin-import` の `import/order`                                    | ✅         |
| ④   | aws-cdk-lib のサービスモジュールは barrel 形式に統一                  | 自作ルール `local/aws-cdk-lib-barrel-import`                                | ✅（一部） |

「プラグインで規約通りに設定できるものはプラグイン、できないものだけ自作ルール」の方針。④のみ該当する標準ルールが無いため自作した（[eslint-rules/awsCdkLibBarrelImport.mjs](eslint-rules/awsCdkLibBarrelImport.mjs)）。

### ④ 自作ルールの autofix 範囲

- `import * as s3 from 'aws-cdk-lib/aws-s3'` → `import { aws_s3 as s3 } from 'aws-cdk-lib'` は**自動修正する**（ローカル名 `s3` を保てるため安全）。
- `import { Bucket } from 'aws-cdk-lib/aws-s3'` は**検出のみ**。使用箇所（`Bucket` → `s3.Bucket`）の書き換えを伴い自動修正が非安全なため手動で直す。

## 使い方

```bash
npm install          # 依存を導入
npm run lint         # 静的解析（違反があれば非ゼロ終了）
npm run lint:fix     # 自動修正込みで実行
npm run test:rule    # 自作ルールの単体テスト（RuleTester）
```

`src/` に規約準拠の記述例を置いている（`appImportExample.ts`＝アプリ、`infraImportExample.ts`＝CDK）。
