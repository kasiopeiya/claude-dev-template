# app アーキテクチャサンプル（ArchUnitTS 対象）

クリーンアーキテクチャ構成のサンプルコードを収める。ArchUnitTS によるアーキテクチャテストを **app コードだけに適用し `cdk/`（インフラ）へ及ぼさない** ため、自前の `package.json` / `tsconfig.json` で TS プロジェクト境界を持つ。リント設定は共通で `sample/eslint.config.mjs`（ルート）が `src/` も対象にするので、ここには置かない。

## 構成（依存方向）

```text
src/
├── domain/                       # 最内・依存なし（方針）
│   ├── user.ts                   #   User エンティティ＋不変条件
│   └── userRepository.ts         #   永続化のポート（抽象）
├── usecase/
│   └── registerUser.ts           # → domain（ポートに依存＝依存性逆転）
├── infrastructure/
│   └── inMemoryUserRepository.ts # → domain（ポート実装＝詳細）
├── presentation/
│   └── registerUserController.ts # → usecase（薄いアダプタ）
└── main.ts                       # 合成ルート（ここだけ全層の具体を結線）
```

依存方向は `presentation → usecase → domain ← infrastructure`。`domain` は何も import しない。この一方向・非循環の構造が、ArchUnitTS の境界テスト・循環依存テストの対象になる。

## スクリプト

```bash
npm install        # 依存を導入
npm run typecheck  # 型検査（src のみ。cdk は対象外）
```

リント・フォーマットはルート（`sample/`）に共通化しているため、`sample/` で `npm run lint` / `npm run format` を実行する。

## ArchUnitTS 本体の導入

このプロジェクトを土台に issue #17 で実施する（依存追加・境界/循環テスト・結合度メトリクス・CI 組込み）。タスクの詳細は issue #17 を SSOT とする。
