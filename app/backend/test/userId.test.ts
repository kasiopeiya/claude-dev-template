// 責務: UserId が生成時に非空の不変条件を保証し、破れたときにビジネス例外で拒否することを検証する

import { BusinessError } from '../domain/businessError'
import { UserId } from '../domain/userId'

describe('ユーザーIDの値オブジェクト', () => {
  it('非空の場合に元の文字列を保持して生成される', () => {
    const sut = UserId.create('user-001')

    expect(sut.value).toBe('user-001')
  })

  it('前後に空白を含む場合に空白を除いた文字列を保持して生成される', () => {
    const sut = UserId.create('  user-001  ')

    expect(sut.value).toBe('user-001')
  })

  it('空文字または空白のみの場合にビジネス例外を投げる', () => {
    expect(() => UserId.create('   ')).toThrow(BusinessError)
  })
})
