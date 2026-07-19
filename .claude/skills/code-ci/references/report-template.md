# CI Report Templates

各フェーズの結果に応じて、以下のテンプレートを使用して出力してください。

---

## 環境エラー（Phase 1 失敗時）

```
🔴 環境エラー

Error: node_modules が見つかりません（[ワークスペース名]）

以下のコマンドで依存関係をインストールしてください:
cd [ワークスペース名] && npm install
```

---

## Prettier チェック失敗（Phase 2 失敗時）

```
🔴 CI Failed: Prettier Check

フォーマット違反が検出されました:
- [違反ファイルパス 1]
- [違反ファイルパス 2]

修正方法:
npm run format

CIチェックを中断します。
```

---

## ESLint 失敗（Phase 2 失敗時）

```
🔴 CI Failed: ESLint

以下のファイルでエラーが検出されました:

[ファイルパス]:[行]:[列]
  Error: [エラーメッセージ]
  Rule: [ルール名]

修正方法:
1. [具体的な修正内容]
2. 自動修正を試す: npm run lint:fix

CIチェックを中断します。
```

---

## knip 失敗（Phase 2 失敗時）

```
🔴 CI Failed: knip

未使用の export / ファイル / 依存が検出されました:

[ファイルパス]:[行]  [種別（unused export / unused file / unused dependency など）]

修正方法:
1. 不要なら削除する
2. 文字列パス等で参照され誤検知なら knip.jsonc に登録する
3. 自動削除を試す: npm run knip:fix

CIチェックを中断します。
```

---

## TypeScript 型チェック失敗（Phase 3 失敗時）

```
🔴 CI Failed: TypeScript Type Check ([ワークスペース名])

以下のファイルで型エラーが検出されました:

[ファイルパス]:[行]:[列]
  Error TS[エラーコード]: [エラーメッセージ]

修正方法:
[型エラーの原因と修正方法の説明]

CIチェックを中断します。
```

---

## 単体テスト失敗（Phase 3 失敗時）

```
🔴 CI Failed: Unit Tests ([ワークスペース名])

以下のテストが失敗しました:

[テストファイルパス]
  Test: [テスト名]

  Expected: [期待値]
  Received: [実際の値]

  at [テストファイルパス]:[行]:[列]

修正方法:
1. [原因の分析]
2. [修正内容]
3. 修正後、再度テストを実行

CIチェックを中断します。
```

---

## CI 成功（全フェーズ通過時）

```
✅ CI Passed!

All checks completed successfully.

=== Summary ===

Prettier Check:              ✅ Passed
ESLint:                      ✅ Passed
knip:                        ✅ Passed
Type Check ([ワークスペース名]): ✅ Passed
Unit Tests ([ワークスペース名]): ✅ Passed ([X] tests)

（Type Check / Unit Tests は検出した各ワークスペース分、上記2行を繰り返す）

Total Tests: [全ワークスペースの合計] tests passed

=== Next Steps ===

1. git add . && git commit でコミット作成
2. git push でリモートにプッシュ
3. PR を作成してコードレビューを依頼

CIチェック完了！
```
