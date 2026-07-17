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

## Import はファイル冒頭に集約する

すべての `import` 文はファイル先頭（最初の非 import 文より前）にまとめる。コードの途中に `import` を置いてはならない（ESLint `import/first` 相当）。

依存関係はファイル冒頭を見れば一覧できる状態に保つ。途中の import は依存の見落とし・循環参照の発見を妨げ、「このファイルが何に依存するか」を掴むコストを上げる。

```typescript
// ✅ 良い例：すべて冒頭に集約
import { readFile } from 'fs/promises'
import { parseConfig } from './config'

const config = parseConfig()

// ❌ 避けるべき例：コードの途中で import
const config = parseConfig()
import { parseConfig } from './config' // 冒頭以外での import は禁止
```

遅延読み込みが必要な場合のみ動的 `import()` を関数内で使ってよいが、なぜ静的 import にしないかを WHY コメントで明記する。

## 規模・複雑度の上限（CIゲートで機械的に強制）

次の数値はこのファイルを SSOT とし、ESLint / tsconfig の CI ゲートで自動検知する（設定例は [README.md](../../README.md)）。数値を変えるときはまずここを直す。

- 関数は**50行以内**（コメント・空行を除く）。超えるのは責務過多のサインなので分割する
- 関数の引数は**3個まで**。4個以上になるならオブジェクト引数へまとめる
- 循環的複雑度（分岐数）・認知的複雑度（ネスト深度を織り込む）は各**15以内**

## 例外処理・制御フロー

- `try` ブロックは20行以内に収める。長い場合は処理を関数に分割する
- `if` / `try` / `for` / `while` のネストは2重まで。3重以上は禁止

### ネスト制限は「設計を見直せ」というシグナル（数だけ消さない）

深いネストを書きたくなるのは、その関数が責務を抱えすぎ／制御フローが複雑すぎるという **code smell** である。制限はこの smell の早期検知が目的で、インデントの見た目を整えるためではない。違反したら**まず設計を見直す**：責務を名前付き関数へ抽出する、早期 return / ガード節で本筋を浅くする、分岐自体を要らない形に設計し直す。

逆に、**複雑さを温存したままネストの「数」だけ消す小手先の回避は禁止**（レビューでも違反扱い）。典型は、ネスト逃れの `.then` / `.catch` チェーン化や多段三項など「制御構文の見た目だけ消す」変形である。

```typescript
// ❌ ネスト逃れのための .catch（複雑さは残り、エラーの流れも追いにくい）
const user = await fetchUser().catch(() => null)
// ✅ 責務を関数へ切り出し、ネストも複雑さも下げる
const user = await loadUser()
```

## 改行スタイル

見やすさを損ねない範囲で行数を最小限にする。引数・オブジェクト・配列は1行に収まる場合はインラインで記述する。

````typescript
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
- 短さより具体性を優先する。多少長くなっても「何の値か」が伝わる名前にする（略語回避とは別の軸——省略していなくても曖昧なら不十分）。文脈を名前に織り込む（`filePath` → `targetFilePath`、`relPath` → `targetRelativePath`、`list` → `policyList`）
- 真偽値は `is` / `has` / `should` / `can` などのプレフィックスで意図を明示する
- 関数名は動詞で始める（`getUser`、`validateInput`、`createSession`）
- クラス名は目的（担う一つの責務）が分かる狭い名前にする。`Money`・`Manager`・`Util` のような広い名前は、あらゆる処理を招き入れて神クラス化する。設計上の根拠と判断基準は [application-design-policy「神クラスアンチパターンを禁ずる」](../../docs/policy/application-design-policy.md) を参照
- 定数は目的が伝わる名前にする（`3000` → `REQUEST_TIMEOUT_MS`）
- ファイル名はそのファイルが担う責務を表す名前にする（`utils.ts` → `dateFormatter.ts`、`helpers.ts` → `tokenValidator.ts`）

```typescript
// ✅ 良い例：名前だけで意図が伝わる
const isSessionExpired = expiresAt < Date.now()
const fetchActiveUsers = async () => { ... }

// ❌ 避けるべき例：意図が不明
const flag = expiresAt < Date.now()
const getData = async () => { ... }
````

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

### モジュール冒頭に責務を一文で書く

各モジュール（ファイル）の冒頭に、そのモジュールの責務を**一文**で書く。これは「名前で足りるならコメント不要」の例外である。関数の責務は関数名1つで伝わるが、ファイルという**まとまりの境界**——なぜこれらが1ファイルに同居するのか、何を含み何を含まないか——は名前1つでは表せない。その境界判断（WHY）を一文で固定する。

同時にこれは単一責任（SRP）のセルフチェックを兼ねる。**一文に "and"／「〜と〜」が混ざるなら責務過多のシグナル**であり、ファイル分割を検討する（[application-design-policy](../../docs/policy/application-design-policy.md)）。

```typescript
// 責務: OAuth の state パラメータの生成と検証のみを担う
//   ↑ "生成と検証" は1つの関心事（state のライフサイクル）なのでOK

// ❌ 責務: ユーザー取得と、通知送信と、課金計算
//   ↑ "and" が並ぶ＝3責務。ファイルを分ける
```

- ファイル名の言い換えを書かない（`tokenValidator.ts` に「トークンを検証する」は WHAT の直訳で無価値）。**境界・スコープ**が伝わる一文にする
- 通常のコメント（`//` または先頭 `/** */`）でよい。装飾は不要
- これは**責務の宣言**であり、心臓部を指す「重要箇所バナー」とは目的が違う（混同しない）。両者は併存しうる

### 重要箇所バナー：ファイルの心臓部を視覚的に指す

そのファイルの心臓部（最重要のビジネスロジック・`main` 等）**1箇所だけ**に、読まずに目へ飛び込むバナーを打つ。設計上の位置づけは [application-design-policy「レイアウトで重要箇所を語らせる」](../../docs/policy/application-design-policy.md) を参照。

```typescript
// ═══════════════════════════════════════════════
//  ★ このファイルの心臓部 — 課金計算ロジック
// ═══════════════════════════════════════════════
export function calculateBillingAmount(invoice: Invoice): Amount {
  ...
}
```

- 1ファイルに最大1個（希少だから信号になる。複数打つと何も目立たない）
- 右枠は付けない。区切り線（`═`）は上記をそのままコピペし、内容に合わせて長さを調整しない
- これは視覚マーカーであり意味タグではない。`// CRITICAL:` のような grep 用タグとは目的が違うので混同しない
