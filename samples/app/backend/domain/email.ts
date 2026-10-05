// 責務: メールアドレスという値オブジェクト——形式と長さの不変条件を生成時に保証する

import { BusinessError } from './businessError'

// RFC 5321 の上限254オクテットに合わせるが、判定を単純にするため UTF-16 コード単位で数える
// （目的は後段の正規表現に対する ReDoS 対策で、RFC への厳密な準拠ではない）。
const MAX_EMAIL_LENGTH = 254

/**
 * メールアドレスを表す値オブジェクト。
 * `create` を通した値だけが存在でき、形式が不正な値や長すぎる値のインスタンスは作れない。
 * これにより「有効なメールか」の検証がこの型の中に集約される（Primitive Obsession の回避）。
 */
export class Email {
  private constructor(public readonly value: string) {}

  /**
   * メールアドレスを生成する。不正な値は生成を拒否する。
   * @param rawEmailAddress 検証前のメールアドレス文字列
   * @returns 生成された Email
   * @throws {BusinessError} 形式が不正な場合、または長さ（UTF-16 コード単位）が254文字を超える場合
   */
  static create(rawEmailAddress: string): Email {
    // 下の正規表現は最悪で入力長の2乗の時間がかかるため、先に長さで弾く
    if (rawEmailAddress.length > MAX_EMAIL_LENGTH) {
      throw new BusinessError(`email too long: ${rawEmailAddress.length} chars`)
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(rawEmailAddress)) {
      throw new BusinessError(`invalid email: ${rawEmailAddress}`)
    }
    return new Email(rawEmailAddress)
  }
}
