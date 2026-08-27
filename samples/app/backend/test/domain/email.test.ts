// 責務: Email が生成時に形式の不変条件を保証し、破れたときにビジネス例外で拒否することを検証する

import { BusinessError } from '../../domain/businessError'
import { Email } from '../../domain/email'

describe('メールアドレスの値オブジェクト', () => {
  it('形式が有効な場合に元の文字列を保持して生成される', () => {
    const sut = Email.create('user@example.com')

    expect(sut.value).toBe('user@example.com')
  })

  it('形式が不正な場合にビジネス例外を投げる', () => {
    expect(() => Email.create('not-an-email')).toThrow(BusinessError)
  })
})
