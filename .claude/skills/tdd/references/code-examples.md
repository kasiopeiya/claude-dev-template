# テスト・実装・リファクタリングの生成例

`/tdd` がテスト・実装・リファクタリングのコードを書き起こすときに読む。何を書くかの基準は Phase 2 の冒頭で読み込んだテスト方針そのもので、ここはその適用例を示す。

## テストコード（バックエンド: Lambda handler）

```typescript
// src/handlers/__tests__/authorize.test.ts
import { handler } from '../authorize'

// Object Mother: APIGatewayイベントのファクトリ関数
const createApiGatewayEvent = (overrides?: Partial<APIGatewayProxyEvent>) => ({
  httpMethod: 'GET',
  path: '/authorize',
  headers: {},
  pathParameters: null,
  queryStringParameters: null,
  body: null,
  ...overrides
})

describe('認可エンドポイント', () => {
  const sut = handler

  it('正常なリクエストの場合に認可URLへのリダイレクトを返す', async () => {
    const event = createApiGatewayEvent()

    const result = await sut(event, context)

    expect(result.statusCode).toBe(302)
    expect(result.headers?.Location).toContain('https://auth.example.com/authorize')
  })

  it.each(['', 'invalid', '@no-local', 'no-domain@'])(
    'メールアドレス「%s」が不正な場合に400を返す',
    async (email) => {
      const event = createApiGatewayEvent({ body: JSON.stringify({ email }) })

      const result = await sut(event, context)

      expect(result.statusCode).toBe(400)
    }
  )

  it('必須パラメータが欠落している場合に400を返す', async () => {
    // Arrange
    const event = createApiGatewayEvent({
      queryStringParameters: {}
    })

    // Act
    const result = await sut(event, context)

    // Assert
    const body = JSON.parse(result.body)
    expect(result.statusCode).toBe(400)
    expect(body.error).toBe('invalid_request')
  })
})
```

## テストコード（フロントエンド: コンポーネント）

```typescript
// src/components/__tests__/LoginForm.test.tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { LoginForm } from '../LoginForm'

describe('ログインフォーム', () => {
  it('フォーム送信失敗時にエラーメッセージを表示する', async () => {
    render(<LoginForm />)

    await userEvent.click(screen.getByRole('button', { name: '送信' }))

    expect(screen.getByText('入力内容を確認してください')).toBeInTheDocument()
  })
})
```

## 実装コード（Green フェーズの最小実装）

```typescript
// src/utils/state.ts

/**
 * OIDC stateパラメータを検証する
 *
 * WHY: CSRF攻撃を防ぐため、認可リクエスト時に生成したstateと
 *      コールバック時に受け取ったstateが一致することを確認する
 *
 * @param state - コールバックで受け取ったstate
 * @param expectedState - 認可リクエスト時に生成したstate
 * @returns stateが一致する場合true、それ以外false
 */
export function verifyState(state: string, expectedState: string): boolean {
  return state === expectedState
}
```

## リファクタリング後のテストコード

変数名を役割が分かる名前に変え、期待値を定数に切り出した例。

```typescript
// src/utils/state.test.ts
import { verifyState } from './state'

describe('verifyState', () => {
  const VALID_STATE = 'abc123'
  const INVALID_STATE = 'xyz789'

  test('正しいstateが渡された場合にtrueを返す', () => {
    // WHY: OIDC認可フローでstateパラメータが改ざんされていないことを確認するため
    const actualState = VALID_STATE
    const expectedState = VALID_STATE

    const result = verifyState(actualState, expectedState)

    expect(result).toBe(true)
  })

  test('異なるstateが渡された場合にfalseを返す', () => {
    // WHY: CSRF攻撃を防ぐため、不正なstateは拒否する必要がある
    const actualState = INVALID_STATE
    const expectedState = VALID_STATE

    const result = verifyState(actualState, expectedState)

    expect(result).toBe(false)
  })
})
```
