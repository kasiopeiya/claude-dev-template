# テスト方針準拠チェック詳細

Phase 2（テスト作成）と Phase 4（実装）の準拠チェックで照合する項目と、その NG/OK パターン集。判定の基準は Phase 2 の冒頭で読み込んだテスト方針そのもので、ここはその具体例を示す。

## Phase 2（テスト作成）のチェック

生成したテストコードを全項目に照らして確認する。

| 観点               | ✅ 準拠                                                                                                                        | ❌ 違反時の対応                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| SUT の明示         | `const sut = handler` 等でテスト対象を明示                                                                                     | 明示されていない → 修正                                                                                                 |
| AAAパターン        | Arrange → Act（1行） → Assert の構成                                                                                           | Act が複数行 → 警告（カプセル化の見直しを提案）                                                                         |
| フェーズコメント   | 準備 or 確認が複数行の場合のみ `// Arrange` `// Act` `// Assert` を記載                                                        | シンプルなテストに付いている → 削除／複数行なのに無い → 追加                                                            |
| テストケース命名   | 日本語、メソッド名なし、事実表現（「〜を返す」「〜される」）                                                                   | 英語 / メソッド名を含む / 曖昧な表現 → 修正                                                                             |
| テストダブル方針   | モック未使用、またはポリシーが名指しする限定例外に当たり理由コメントがある。スタブはプロセス外依存・速度や決定性を壊す依存のみ | プライベート依存のスタブ / 内部関数のモック / 限定例外に当たらないモック検証 / スタブへの `toHaveBeenCalledWith` → 警告 |
| テストデータの配置 | テスト関数内に直接記述、または Object Mother パターン                                                                          | fixture ファイル使用 / `beforeEach` にテスト固有データ → 警告                                                           |
| テストケースの分離 | 仕様上の条件ごとに分離し、正常系と異常系を分離                                                                                 | 異なる仕様条件が1テストにまとまっている → 分離を提案                                                                    |
| パラメータ化テスト | 同一仕様条件のバリエーションに `it.each` を使用                                                                                | 異なる仕様条件を `it.each` にまとめている → 分離を提案                                                                  |
| 検証対象           | 観察可能な振る舞い（出力・戻り値・状態変化）を検証                                                                             | 実装の詳細（内部メソッドの呼び出し順序、内部変数の中間状態）を検証 → 警告                                               |
| テスト対象の妥当性 | ビジネスロジック / 事前条件チェック / サポートログ                                                                             | private メソッド / 単純な委譲 / 診断ログ / ライブラリ内部 → テスト不要と警告                                            |
| テスト内 if 文     | if 文なし                                                                                                                      | if 文あり → テストケースの分割を提案                                                                                    |
| フロントエンド固有 | ユーザーが認識できる属性で要素取得（クエリの優先順位は react.md が定める）                                                     | 内部 state / props の直接検証 → 警告                                                                                    |

### SUT の明示

```typescript
// ❌ NGパターン: SUT が不明確
it('正常なリクエストの場合にリダイレクトを返す', async () => {
  const result = await handler(event, context) // handler が SUT だと明示されていない
  expect(result.statusCode).toBe(302)
})

// ✅ OKパターン: SUT を明示
describe('認可エンドポイント', () => {
  const sut = handler

  it('正常なリクエストの場合にリダイレクトを返す', async () => {
    const event = createApiGatewayEvent()

    const result = await sut(event, context)

    expect(result.statusCode).toBe(302)
  })
})
```

### AAAパターンとフェーズコメント

```typescript
// ❌ NGパターン: シンプルなテストに不要なフェーズコメント
it('有効なIDの場合にユーザー情報を返す', async () => {
  // Arrange  ← 不要（準備が1行のため）
  const event = createApiGatewayEvent({ pathParameters: { id: 'user-123' } })

  // Act  ← 不要
  const result = await sut(event, context)

  // Assert  ← 不要（確認が1行のため）
  expect(result.statusCode).toBe(200)
})

// ✅ OKパターン: シンプルなテスト → 空白行のみで区切る
it('有効なIDの場合にユーザー情報を返す', async () => {
  const event = createApiGatewayEvent({ pathParameters: { id: 'user-123' } })

  const result = await sut(event, context)

  expect(result.statusCode).toBe(200)
})

// ✅ OKパターン: 準備が複数行 → フェーズコメントを入れる
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
})
```

### テストケース命名

```typescript
// ❌ NGパターン: メソッド名を含む
'handleRequestは不正な入力に対して400を返す'

// ❌ NGパターン: 検証内容が曖昧
'不正な入力でエラーを返す'

// ✅ OKパターン: 日本語、メソッド名なし、事実表現
'必須パラメータが欠落している場合に400を返す'
'有効期限切れのセッションは拒否される'
```

### テストダブル方針

```typescript
// ❌ NGパターン: 内部関数のモック
vi.mock('./utils/helper')

// ❌ NGパターン: スタブとのやりとりを検証（過剰検証）
const stubRepository = { findById: vi.fn(() => ({ id: 'user-123', name: 'Alice' })) }
// ...テスト実行後...
expect(stubRepository.findById).toHaveBeenCalledWith('user-123') // スタブの検証は禁止

// ✅ OKパターン: スタブはデータ提供のみ、最終結果を検証
const stubRepository = { findById: () => ({ id: 'user-123', name: 'Alice' }) }
const result = await sut(event, context)
expect(result.statusCode).toBe(200)

// ✅ OKパターン: 呼び出し回数自体が仕様（キャッシュ）＝ポリシーの限定例外
// WHY: 2回目はキャッシュから返し、元データを呼ばないことが仕様のため
const mockFetchUser = vi.fn(() => ({ id: 'user-123', name: 'Alice' }))
```

### テストデータの配置

```typescript
// ❌ NGパターン: beforeEach にテスト固有データ
let event: APIGatewayProxyEvent
beforeEach(() => {
  event = createApiGatewayEvent({ pathParameters: { id: 'user-123' } })
})

// ✅ OKパターン: Object Mother パターン + テスト関数内でカスタマイズ
const createApiGatewayEvent = (overrides?: Partial<APIGatewayProxyEvent>) => ({
  httpMethod: 'GET',
  path: '/',
  headers: {},
  pathParameters: null,
  queryStringParameters: null,
  body: null,
  ...overrides
})

it('有効なIDの場合にユーザー情報を返す', async () => {
  const event = createApiGatewayEvent({ pathParameters: { id: 'user-123' } })

  const result = await sut(event, context)

  expect(result.statusCode).toBe(200)
})
```

### テストケースの分離とパラメータ化

```typescript
// ❌ NGパターン: 異なる仕様条件を1つのテストにまとめている
it('不正なリクエストの場合にエラーを返す', async () => {
  // 未認証と不正メールが混在
})

// ✅ OKパターン: 仕様条件ごとに分離、同一条件のバリエーションは it.each
it.each(['', 'invalid', '@no-local'])(
  'メールアドレス「%s」が不正な場合に400を返す',
  async (email) => {
    const event = createApiGatewayEvent({ body: JSON.stringify({ email }) })

    const result = await sut(event, context)

    expect(result.statusCode).toBe(400)
  }
)

it('未認証の場合に403を返す', async () => {
  const event = createApiGatewayEvent({ headers: {} })

  const result = await sut(event, context)

  expect(result.statusCode).toBe(403)
})
```

### 検証対象

```typescript
// ❌ NGパターン: 実装の詳細を検証
expect(formatNameSpy).toHaveBeenCalledWith('alice')
expect(validateInputSpy).toHaveBeenCalledTimes(1)

// ✅ OKパターン: 観察可能な振る舞い（出力）を検証
const result = await sut(event, context)
expect(result.statusCode).toBe(200)
expect(JSON.parse(result.body).userId).toBe('user-123')
```

### 違反時の警告フォーマット

```
⚠️ テスト方針違反を検出

Phase 2: テスト作成

違反内容:
- {違反した観点と、何がどう違反しているか}

対処方法:
1. {具体的な修正手順}

修正しますか？
[はい / このまま続行]
```

## Phase 4（実装）のチェック

生成した実装コードを全項目に照らして確認する。

| 観点         | ✅ 準拠                                | ❌ 違反時の対応                                             |
| ------------ | -------------------------------------- | ----------------------------------------------------------- |
| 最小限の実装 | テストを通すために必要な最小限のコード | テストにない機能の追加 → 警告、削除を提案                   |
| 最適化の禁止 | シンプルな実装                         | パフォーマンス最適化 → リファクタリングフェーズへ延期を提案 |
| コメント     | WHYコメント記載                        | WHATコメントのみ → 警告                                     |

### 最小限の実装

```typescript
// ❌ NGパターン: テストにない機能の追加
export function verifyState(state: string, expectedState: string): boolean {
  // バリデーション（テストにない）
  if (!state || !expectedState) {
    throw new Error('Invalid input')
  }

  return state === expectedState
}

// ✅ OKパターン: 最小限の実装
export function verifyState(state: string, expectedState: string): boolean {
  return state === expectedState
}
```

### 過度な最適化の禁止

```typescript
// ❌ NGパターン: 最適化コード
export function verifyState(state: string, expectedState: string): boolean {
  // 長さチェックで早期リターン（最適化）
  if (state.length !== expectedState.length) {
    return false
  }

  return state === expectedState
}

// ✅ OKパターン: シンプルな実装
export function verifyState(state: string, expectedState: string): boolean {
  return state === expectedState
}
```

### 違反時の警告フォーマット

```
⚠️ TDD原則違反を検出

Phase 4: 実装

違反内容:
- {テストにない機能が実装されている等}

TDD原則:
- テストを通す最小限のコードのみ実装する

対処方法:
1. {具体的な修正手順}

修正しますか？
[はい / このまま続行]
```
