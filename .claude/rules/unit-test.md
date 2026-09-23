---
paths:
  - '**/*.test.ts'
  - '**/*.test.tsx'
  - '**/*.test.mjs'
---

# 単体テストの書き方

テストの**思想**（古典学派・検証原則・テストダブルの使用方針など）は [unit-test-policy.md](../../docs/policy/unit-test-policy.md) が定める。ここでは、それを踏まえた**書き方（How）**だけを定める。

## 対象読者

AIエージェントが、単体テストのコードを実装・レビューし、AAAパターン・命名・SUT・テストケースの分離・パラメータ化・フィクスチャの書き方に迷ったとき。

## SUT（テスト対象）の明示

テスト対象は変数名 `sut` で明示し、テスト対象と依存の区別をわかりやすくする。

```typescript
const sut = handler
const result = await sut(event, context)
```

## AAAパターン（Arrange-Act-Assert）

すべてのテストケースを3つのフェーズで構成する。

| フェーズ        | ルール                                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| Arrange（準備） | 長すぎる場合、テストダブルで隠さず、プロダクションコードの設計を見直すシグナルとして扱う                 |
| Act（実行）     | **必ず1行**。ただし `toThrow`/`rejects.toThrow` で例外を確認する場合は Act と Assert を1文にまとめてよい |
| Assert（確認）  | 複数assertは許容するが、多すぎる場合は焦点がぼやけていないか見直す                                       |

**フェーズコメントの記載ルール：**

- **準備または確認フェーズの中を、さらに空白行で区切る**：各フェーズの先頭に `// Arrange` `// Act` `// Assert` を入れる（空白行だけではフェーズの境目と見分けられないため）
- **それ以外**：コメントは入れず、**空白行のみ**でフェーズを区切る

```typescript
// ✅ 良い例：フェーズの中に空白行が無い → 空白行のみでフェーズを区切る
it('有効なIDを指定した場合にユーザー情報を返す', async () => {
  const event = createApiGatewayEvent({ pathParameters: { id: 'user-123' } })

  const result = await sut(event, context)

  expect(result.statusCode).toBe(200)
  expect(JSON.parse(result.body).name).toBe('Alice')
})

// ✅ 良い例：準備の中を空白行で区切る → フェーズコメントを入れる
it('ゴールド会員の場合に割引が適用された注文サマリーを返す', async () => {
  // Arrange
  const user = createUser({ membershipLevel: 'gold' })
  const items = [createItem({ price: 1000 }), createItem({ price: 2000 })]

  const event = createApiGatewayEvent({
    body: JSON.stringify({ userId: user.id, items })
  })

  // Act
  const result = await sut(event, context)

  // Assert
  const body = JSON.parse(result.body)
  expect(result.statusCode).toBe(200)
  expect(body.totalAmount).toBe(2700)
  expect(body.discountApplied).toBe(true)
})
```

## テストケースの命名規則

- **日本語で書く**（`describe` も含む。ESLint `no-restricted-syntax` がガードレール化済み。違反したら振る舞いを日本語で言い直す）
- テスト対象の**メソッド名を含めない**（テストはコードではなく振る舞いを検証している）
- 「〜する」「〜される」「〜を返す」のように**事実を示す表現**で書く

```typescript
// ✅ 良い例：日本語で振る舞いが明確、メソッド名を含まない
'必須パラメータが欠落している場合に400を返す'

// ❌ 悪い例：メソッド名を含む
'handleRequestは不正な入力に対して400を返す'

// ❌ 悪い例：検証内容が曖昧
'不正な入力でエラーを返す' // 何がどう不正で、どのエラーを返すかが不明確
```

## テスト内でif文を使わない

if 文があれば ESLint `no-restricted-syntax` が検知する。違反したら、1つのテストで多くをしようとしている兆候なのでテストケースを分割する。

## テストケースの分離基準

テストケースを分けるか1つにまとめるかは、**仕様上の条件が異なるかどうか**で判断する。前提条件（Arrange）の入力値が異なっていても、仕様上同じ条件のバリエーションであれば1つのテストケースにまとめてよい。

**仕様上の条件とは：** テストケース名における条件部分（「〜の場合に」）を指す。この条件部分が同じ文言で自然に表現できるなら同じ条件であり、異なる文言でないと区別できないなら異なる条件と判断する。

| 入力値               | テストケース名の条件部分                     | 判断            |
| -------------------- | -------------------------------------------- | --------------- |
| `email = ''`         | 「メールアドレスの形式が不正な場合に」       | 同じ → まとめる |
| `email = '@foo'`     | 「メールアドレスの形式が不正な場合に」       | 同じ → まとめる |
| ゲストのトークン     | 「閲覧権限のないロールの場合に」             | 異なる → 分ける |
| 他ユーザーのリソース | 「他ユーザーのリソースにアクセスした場合に」 | 異なる → 分ける |

```typescript
// ✅ まとめてよい：入力値は異なるが、仕様上は同じ条件（メール形式不正）
it.each(['', 'invalid', '@no-local'])(
  'メールアドレス「%s」が不正な場合に400を返す',
  async (email) => {
    const event = createApiGatewayEvent({ body: JSON.stringify({ email }) })

    const result = await sut(event, context)

    expect(result.statusCode).toBe(400)
  }
)

// ✅ 分けるべき：出力は同じ403だが、仕様上は別の条件
it('閲覧権限のないロールの場合に403を返す', async () => {
  /* ... */
})
it('他ユーザーのリソースにアクセスした場合に403を返す', async () => {
  /* ... */
})
```

## パラメータ化テスト

- 仕様上同じ条件のバリエーションに異なる入力を流し込む場合に使用する
- **正常系と異常系は必ず分離する**

```typescript
// ❌ 悪い例：期待値の列で正常系と異常系を1つの表に混ぜる
it.each([
  [-1, false],
  [2, true]
])('当日から%d日後の日付の判定は%sである', (days, expected) => {
  const today = new Date('2026-01-10')

  const result = sut(addDays(today, days), today)

  expect(result).toBe(expected)
})

// ✅ 良い例：正常系と異常系を分けたパラメータ化テスト
describe('配送日バリデーション', () => {
  const sut = isValidDeliveryDate

  it.each([-1, 0, 1])('当日から%d日後の日付は無効である', (days) => {
    const today = new Date('2026-01-10')

    const result = sut(addDays(today, days), today)

    expect(result).toBe(false)
  })

  it.each([2, 3, 10])('当日から%d日後の日付は有効である', (days) => {
    const today = new Date('2026-01-10')

    const result = sut(addDays(today, days), today)

    expect(result).toBe(true)
  })
})
```

## beforeEachでの過度な共通化を避ける

`beforeEach` でテストフィクスチャを共通化すると、テストケース間の結合が強くなり、1つのテストの修正が他のテストに影響するリスクが生じる。

| 配置                  | 対象                                   | 例                                     |
| --------------------- | -------------------------------------- | -------------------------------------- |
| ✅ 配置してよい       | テスト実行に最低限必要な土台           | DB接続の初期化、ログ出力の初期化       |
| ❌ 配置してはならない | テストケース固有のデータ・オブジェクト | 入力イベントの生成、スタブの戻り値設定 |

## テストデータの共通化パターン

テストデータは、デフォルト値を持つファクトリ関数で作り、テストごとに意図のある項目だけ上書きする。この抽象化は DAMP と矛盾しない——`createUser({ membershipLevel: 'gold' })` のように**入力データの意図が呼び出し側に残る**ため。

```typescript
// ファクトリ関数：デフォルト値を持つテストデータを生成
const createApiGatewayEvent = (overrides?: Partial<APIGatewayProxyEvent>) => ({
  httpMethod: 'GET',
  path: '/',
  headers: {},
  pathParameters: null,
  queryStringParameters: null,
  body: null,
  ...overrides
})

// 使用例：必要な部分だけ上書き
const event = createApiGatewayEvent({ pathParameters: { id: 'user-123' } })
```
