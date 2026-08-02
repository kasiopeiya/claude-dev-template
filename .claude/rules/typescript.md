---
paths:
  - '**/*.ts'
  - '**/*.tsx'
---

# TypeScript 共通ルール

## 対象読者

TypeScript を書く／レビューする開発者・AIエージェントが、命名・import・改行・規模の上限といったこのプロジェクトの書き方に迷ったとき。

## コーディングスタイル

- ESLint / Prettier の設定に準拠
- `any` を避け、型システムを活用
- doc comment は JSDoc 形式で書き、契約（引数・戻り値・スローする例外）を明記する
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

すべての `import` 文はファイル先頭（最初の非 import 文より前）にまとめる。コードの途中に `import` を置いてはならない（ESLint `import-x/first` 相当）。

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

## 規模・複雑度の上限

次の数値はこのファイルを SSOT とする。数値を変えるときはまずこの表を直す（ESLint 設定の実体は [README.md](../../README.md)）。

| 対象                                   | 上限                         | 超えたときの対処                                   | CI ゲート                        |
| -------------------------------------- | ---------------------------- | -------------------------------------------------- | -------------------------------- |
| 関数の長さ                             | 50行（コメント・空行を除く） | 責務過多のサイン。関数を分割する                   | `max-lines-per-function`         |
| 関数の引数                             | 3個                          | オブジェクト引数へまとめる                         | `max-params`                     |
| 循環的複雑度（分岐数）                 | 15                           | 分岐を関数へ切り出す／分岐自体を要らない設計にする | `complexity`                     |
| 認知的複雑度（ネスト深度を織り込む）   | 15                           | 同上                                               | `sonarjs/cognitive-complexity`   |
| ネスト深さ（`if`/`try`/`for`/`while`） | 2重                          | まず設計を見直す。数だけ消す小手先の回避は禁止     | `max-depth`                      |
| `try` ブロックの長さ                   | 20行                         | 処理を関数へ分割する                               | 機械ゲートなし（レビューで見る） |

ネスト深さと認知的複雑度は別々に効く。前者は「一番深いところ」の上限、後者は「分岐の総量（深いほど重く数える）」の上限なので、片方に収まっても他方で落ちうる。

## ネスト制限は「設計を見直せ」というシグナル（数だけ消さない）

深いネストは責務過多・制御フロー過多の code smell である。違反したら数を減らすのではなく、まず設計を見直す（責務の抽出・早期 return・分岐の単純化）。詳細は [application-design-policy](../../docs/policy/application-design-policy.md) を参照。

複雑さを温存したままネストの「数」だけ消す小手先の回避は禁止（レビューでも違反扱い）。典型は、ネスト逃れの `.then` / `.catch` チェーン化や多段三項など「制御構文の見た目だけ消す」変形である。

```typescript
// ❌ ネスト逃れのための .catch（複雑さは残り、エラーの流れも追いにくい）
const user = await fetchUser().catch(() => null)
// ✅ 責務を関数へ切り出し、ネストも複雑さも下げる
const user = await loadUser()
```

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
```

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
- クラス名は目的（担う一つの責務）が分かる狭い名前にする。`Money`・`Manager`・`Util` のような広い名前は、あらゆる処理を招き入れて神クラス化する。設計上の根拠と判断基準は [application-design-policy](../../docs/policy/application-design-policy.md) が定める（神クラスアンチパターン）
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

コメントの規約は言語に依らないため、基準も記法も [code-comment-policy](../../docs/policy/code-comment-policy.md) が定める。要点は、実装コメントは WHY・doc comment は契約（投げる例外は `@throws {型}`）・ファイル冒頭は責務と前提・TODO は Issue 番号を併記・重要箇所バナーは1ファイル1個。
