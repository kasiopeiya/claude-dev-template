---
globs: **/*.ts
---

# TypeScript 共通ルール

## コーディングスタイル

- ESLint / Prettier の設定に準拠
- `any` を避け、型システムを活用
- JSDoc形式で関数の役割・引数・戻り値・スローする例外を明記
- `export` は外部から参照されるものだけに付ける。モジュール内でのみ使う関数・変数・型には `export` を付けない（`export` が付いていれば「外部で使われるもの」と即座に判断できる）

## Import 順序

以下の順に記載し、各グループ間は空行で区切る：

1. 標準ライブラリ（`fs`, `path`, `crypto` など）
2. サードパーティライブラリ
3. プロジェクト内の自作モジュール

```typescript
// 1. 標準ライブラリ
import * as crypto from 'crypto'

// 2. サードパーティライブラリ
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda'

// 3. 自作モジュール
import { generateState, verifyState } from './utils/state'
```

## 例外処理・制御フロー

- `try` ブロックは20行以内に収める。長い場合は処理を関数に分割する
- `if` / `try` / `for` / `while` のネストは2重まで。3重以上は禁止

## 改行スタイル

見やすさを損ねない範囲で行数を最小限にする。引数・オブジェクト・配列は1行に収まる場合はインラインで記述する。

```typescript
// ✅ 良い例：引数が収まるなら1行で
saveSession(sessionId, { accessToken }, logger)
createUser({ id, name, email }, options)
const result = await fetchData(url, { method: 'POST', body })

// ❌ 避けるべき例：不必要な展開
saveSession(
  sessionId,
  {
    accessToken
  },
  logger
)

// ✅ 良い例：短い配列・オブジェクトはインライン
const config = { timeout: 3000, retries: 2 }

// ✅ 良い例：条件式・三項演算子も1行で収まるなら
const label = isAdmin ? 'Admin' : 'User'
if (error) return { statusCode: 500, body: 'Internal Server Error' }

**例外：** 引数や要素が多く1行が長くなりすぎる場合（目安：100文字超）は適切に改行する。

## 命名規則

> 「エンジニアの仕事は名前を考えることだ」と言われるほど、命名はコードの品質を左右する最重要事項の一つ。
> 適切な名前があれば、コメントや説明なしに意図が伝わる。命名に妥協しない。

命名の対象は変数・関数だけでなく、**クラス・型・ファイル名・ディレクトリ名**も含む。すべての識別子に「なぜその名前か」を説明できる状態を目指す。

- 変数名・関数名は「何をするか／何を表すか」が名前から読み取れるようにする
- 略語は避け、意味が明確な名前を使う（`usr` → `user`、`btn` → `button`）
- 真偽値は `is` / `has` / `should` / `can` などのプレフィックスで意図を明示する
- 関数名は動詞で始める（`getUser`、`validateInput`、`createSession`）
- 定数は目的が伝わる名前にする（`3000` → `REQUEST_TIMEOUT_MS`）
- ファイル名はそのファイルが担う責務を表す名前にする（`utils.ts` → `dateFormatter.ts`、`helpers.ts` → `tokenValidator.ts`）

```typescript
// ✅ 良い例：名前だけで意図が伝わる
const isSessionExpired = expiresAt < Date.now()
const fetchActiveUsers = async () => { ... }

// ❌ 避けるべき例：意図が不明
const flag = expiresAt < Date.now()
const getData = async () => { ... }
```

## コメント

基本方針：**変数名・関数名・クラス名・ファイル名が適切であればコメントは不要**。コメントはコードだけでは伝わらない情報を補足するために書く。コメントを書きたくなったら、まず命名で解決できないか先に検討すること。

### WHY コメントを優先する

- WHAT（何をしているか）はコードを読めばわかる。**WHY（なぜそうしているか）** を書く
- ビジネスルール・制約・トレードオフなど、コードの背景にある判断理由を記載する

```typescript
// ✅ 良い例：WHY（理由・背景）を説明
// Cognito の仕様上、トークン取り消し後もキャッシュにより最大1時間有効なため、
// セッションストア側でも無効化を管理する
await revokeToken(refreshToken)
await invalidateSession(sessionId)

// ❌ 避けるべき例：WHAT（コードの直訳）を書いている
// トークンを取り消してセッションを無効化する
await revokeToken(refreshToken)
await invalidateSession(sessionId)
```

### コメントを書くべき場面

- **設計判断の理由：** なぜこのアプローチを選んだか（代替案を却下した理由など）
- **外部制約：** API仕様・ライブラリの制限・ブラウザ互換性など
- **非自明なロジック：** 一見不自然に見えるが意図的な実装
- **TODO / FIXME：** 既知の課題や将来の改善点（Issue番号を併記）

```typescript
// APIGateway の制約により、レスポンスヘッダーは小文字に正規化される
const token = headers['x-custom-token']

// TODO(#42): バッチサイズを設定可能にする
const BATCH_SIZE = 100
```
