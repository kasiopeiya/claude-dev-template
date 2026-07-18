// 責務: 「ユーザーを登録する」ユースケースのオーケストレーションのみを担う

import { Email } from '../domain/email'
import { User } from '../domain/user'
import { UserId } from '../domain/userId'
import { UserRepository } from '../domain/userRepository'

/** ユーザー登録の入力。外界の境界なので生の文字列で受け取り、内部で値オブジェクトへ変換する。 */
export interface RegisterUserInput {
  id: string
  email: string
}

/**
 * ユーザー登録ユースケース。
 * 永続化の詳細はポート(UserRepository)に委ね、詳細層(infrastructure)には依存しない（依存性逆転）。
 */
export class RegisterUser {
  constructor(private readonly userRepository: UserRepository) {}

  /**
   * ユーザーを登録する。同一 ID が既に存在する場合は登録を拒否する。
   * @param input 登録するユーザーの入力
   * @returns 登録された User
   * @throws {Error} 同一 ID が既に存在する場合、ID が空の場合、またはメール形式が不正な場合
   */
  async execute(input: RegisterUserInput): Promise<User> {
    const id = UserId.create(input.id)
    const email = Email.create(input.email)

    const existingUser = await this.userRepository.findById(id)
    if (existingUser !== null) {
      throw new Error(`user already exists: ${id.value}`)
    }

    const user = User.create(id, email)
    await this.userRepository.save(user)
    return user
  }
}
