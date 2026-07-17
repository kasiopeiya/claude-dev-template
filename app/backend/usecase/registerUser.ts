// 責務: 「ユーザーを登録する」ユースケースのオーケストレーションのみを担う

import { User, UserId } from '../domain/user'
import { UserRepository } from '../domain/userRepository'

/** ユーザー登録の入力。 */
export interface RegisterUserInput {
  id: UserId
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
   * @throws {Error} 同一 ID が既に存在する場合、またはメール形式が不正な場合
   */
  async execute(input: RegisterUserInput): Promise<User> {
    const existingUser = await this.userRepository.findById(input.id)
    if (existingUser !== null) {
      throw new Error(`user already exists: ${input.id}`)
    }

    const user = User.create(input.id, input.email)
    await this.userRepository.save(user)
    return user
  }
}
