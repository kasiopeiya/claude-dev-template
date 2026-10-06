// 責務: 「ユーザーを登録する」ユースケースのオーケストレーションのみを担う

import { Email } from '../domain/email'
import { User } from '../domain/user'
import { UserId } from '../domain/userId'
import { UserRepository } from '../domain/userRepository'

/** ユーザー登録の入力。外界の境界なので生の文字列で受け取り、内部で値オブジェクトへ変換する。 */
interface RegisterUserInput {
  id: string
  email: string
}

/**
 * ユーザー登録ユースケース。
 * @param input 登録するユーザーの入力
 * @returns 登録された User
 * @throws {UserAlreadyExistsError} 同一 ID が既に存在する場合
 * @throws {BusinessError} ID が空の場合、またはメール形式が不正な場合
 */
export type RegisterUser = (input: RegisterUserInput) => Promise<User>

/**
 * ユーザー登録ユースケースを組み立てる。
 * 永続化の詳細はポート(UserRepository)に委ね、詳細層(infrastructure)には依存しない（依存性逆転）。
 * @param userRepository ユーザーの永続化を担うポート
 * @returns ユーザーを登録する関数
 */
export function createRegisterUserUseCase(userRepository: UserRepository): RegisterUser {
  return async (input) => {
    const id = new UserId(input.id)
    const email = new Email(input.email)

    // 存在確認を自分で行うと確認と保存の間に別の登録が割り込むため、重複の判定ごと永続化へ委ねる
    const user = new User(id, email)
    await userRepository.saveNewUser(user)
    return user
  }
}
