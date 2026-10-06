// 責務: Email が生成時に形式と長さの不変条件を保証し、破れたときにビジネス例外で拒否することを検証する

import { BusinessError } from '../../domain/businessError'
import { Email } from '../../domain/email'

describe('メールアドレスの値オブジェクト', () => {
  it('形式が有効な場合に元の文字列を保持して生成される', () => {
    const sut = new Email('user@example.com')

    expect(sut.value).toBe('user@example.com')
  })

  it('形式が不正な場合にビジネス例外を投げる', () => {
    expect(() => new Email('not-an-email')).toThrow(BusinessError)
  })

  it('長さが上限の254文字の場合に生成される', () => {
    const domainWithAtSign = '@example.com'
    const email = `${'a'.repeat(254 - domainWithAtSign.length)}${domainWithAtSign}`

    const sut = new Email(email)

    expect(sut.value).toBe(email)
  })

  it('長さが上限を超える255文字の場合にビジネス例外を投げる', () => {
    const domainWithAtSign = '@example.com'
    const email = `${'a'.repeat(255 - domainWithAtSign.length)}${domainWithAtSign}`

    expect(() => new Email(email)).toThrow(BusinessError)
  })
})
