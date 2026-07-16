# app（クリーンアーキテクチャ構成・ArchUnitTS 対象）

クリーンアーキテクチャ構成で実装する。ArchUnitTS によるアーキテクチャテストを **app コードだけに適用し `infra/`（インフラ）へ及ぼさない** ため、自前の `package.json` / `tsconfig.json` で TS プロジェクト境界を持つ。リント設定は共通で `eslint.config.mjs`（ルート）が `app/` も対象にするので、ここには置かない。

## 構成（依存方向）

```text
app/
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
npm run typecheck  # 型検査（app のみ。infra は対象外）
npm run test       # アーキテクチャテスト（境界・循環依存・凝集度）を実行
```

リント・フォーマットはルート（リポジトリ直下）に共通化しているため、リポジトリ直下で `npm run lint` / `npm run format` を実行する。

## アーキテクチャテスト（ArchUnitTS）

`npm run test`（vitest + `archunit`）が次の3つを機械的に検査する。違反があるとテストが失敗する。

### 境界テスト（`test/architecture.test.ts`）

**「内側レイヤーは外側レイヤーを import しない」**を強制する。

- `domain` は `usecase` / `infrastructure` / `presentation` を import しない
- `usecase` は `infrastructure` / `presentation` を import しない

`main.ts`（合成ルート）はレイヤーフォルダ外のため対象外で、全層を結線してよい。

### 循環依存テスト（`test/cycles.test.ts`）

ファイル間に循環依存が無いことを保証する（`haveNoCycles`）。

### 凝集度メトリクス（`test/metrics.test.ts`）

各クラスの LCOM96b（凝集度の欠如。0=完全凝集〜1=無凝集）を固定しきい値 0.5 未満で検査し、凝集低下を信号として検知する。
