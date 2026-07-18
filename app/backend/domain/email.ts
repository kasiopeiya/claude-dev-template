// 責務: メールアドレスという値オブジェクト——形式の不変条件を生成時に保証する

/**
 * メールアドレスを表す値オブジェクト。
 * `create` を通した値だけが存在でき、不正な形式のインスタンスは作れない。
 * これにより「有効なメールか」の検証がこの型の中に集約される（Primitive Obsession の回避）。
 */
export class Email {
  private constructor(public readonly value: string) {}

  /**
   * メールアドレスを生成する。形式が不正な場合は生成を拒否する。
   * @param value メールアドレス文字列
   * @returns 生成された Email
   * @throws {Error} メール形式が不正な場合
   */
  static create(value: string): Email {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
      throw new Error(`invalid email: ${value}`)
    }
    return new Email(value)
  }
}
