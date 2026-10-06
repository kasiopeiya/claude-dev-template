// 責務: User エンティティ——検証済みの値オブジェクトを合成して不正な状態を作らせない

import { Email } from './email'
import { UserId } from './userId'

/**
 * 登録済みユーザーを表すエンティティ。
 * id・email は生成時に不変条件を検証済みの値オブジェクトなので、User 自身は検証を持たず合成に徹する。
 */
export class User {
  readonly #id: UserId

  readonly #email: Email

  /**
   * User を生成する。
   * @param id ユーザーID（検証済み）
   * @param email メールアドレス（検証済み）
   */
  constructor(id: UserId, email: Email) {
    this.#id = id
    this.#email = email
  }

  get id(): UserId {
    return this.#id
  }

  get email(): Email {
    return this.#email
  }
}
