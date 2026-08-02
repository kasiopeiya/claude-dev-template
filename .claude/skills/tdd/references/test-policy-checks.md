# テスト方針準拠チェック詳細

ステップ 2-3（テスト作成）とステップ 4-3（実装）で照合する NG/OK パターン集。判定の基準はステップ 2-0 で読み込んだテスト方針そのもので、ここはその具体例を示す。

### Phase 2（テスト作成）のチェック

**1. SUT の明示**

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

**2. AAAパターンとフェーズコメント**

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

**3. テストケース命名**

```typescript
// ❌ NGパターン: メソッド名を含む
'handleRequestは不正な入力に対して400を返す'

// ❌ NGパターン: 検証内容が曖昧
'不正な入力でエラーを返す'

// ✅ OKパターン: 日本語、メソッド名なし、事実表現
'必須パラメータが欠落している場合に400を返す'
'有効期限切れのセッションは拒否される'
```

**4. テストダブル方針**

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

**5. テストデータの配置**

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

**6. テストケースの分離とパラメータ化**

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

**7. 検証対象**

```typescript
// ❌ NGパターン: 実装の詳細を検証
expect(formatNameSpy).toHaveBeenCalledWith('alice')
expect(validateInputSpy).toHaveBeenCalledTimes(1)

// ✅ OKパターン: 観察可能な振る舞い（出力）を検証
const result = await sut(event, context)
expect(result.statusCode).toBe(200)
expect(JSON.parse(result.body).userId).toBe('user-123')
```

### Phase 4（実装）のチェック

**1. 最小限の実装**

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

**2. 過度な最適化の禁止**

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
