// 責務: User エンティティと、その生成に伴う不変条件（業務ルール）のみを担う

/** User を一意に識別する ID。 */
export type UserId = string

/**
 * 登録済みユーザーを表すエンティティ。
 * 生成時にメール形式の不変条件を検証し、不正な状態のインスタンスを作らせない。
 */
export class User {
  private constructor(
    public readonly id: UserId,
    public readonly email: string
  ) {}

  /**
   * User を生成する。メール形式が不正な場合は生成を拒否する。
   * @param id ユーザーID
   * @param email メールアドレス
   * @returns 生成された User
   * @throws {Error} メール形式が不正な場合
   */
  static create(id: UserId, email: string): User {
    if (!User.isValidEmail(email)) {
      throw new Error(`invalid email: ${email}`)
    }
    return new User(id, email)
  }

  private static isValidEmail(email: string): boolean {
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)
  }
}
