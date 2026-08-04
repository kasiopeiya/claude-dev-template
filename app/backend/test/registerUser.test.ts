// 責務: ユーザー登録ユースケースが登録の可否をビジネス例外で表すことを検証する

import { BusinessError } from '../domain/businessError'
import { InMemoryUserRepository } from '../infrastructure/inMemoryUserRepository'
import { RegisterUser } from '../usecase/registerUser'

describe('ユーザー登録ユースケース', () => {
  it('未登録のIDの場合に登録したユーザーを返す', async () => {
    const sut = new RegisterUser(new InMemoryUserRepository())

    const user = await sut.execute({ id: 'user-001', email: 'user@example.com' })

    expect(user.id.value).toBe('user-001')
    expect(user.email.value).toBe('user@example.com')
  })

  it('同一IDが既に登録済みの場合にビジネス例外を投げる', async () => {
    const sut = new RegisterUser(new InMemoryUserRepository())
    await sut.execute({ id: 'user-001', email: 'user@example.com' })

    await expect(sut.execute({ id: 'user-001', email: 'other@example.com' })).rejects.toThrow(
      BusinessError
    )
  })
})
