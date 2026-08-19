// 責務: 各層を結線する合成ルート（Composition Root）。ここだけが全層の具体を知ってよい

import { InMemoryUserRepository } from './infrastructure/inMemoryUserRepository'
import { RegisterUserController } from './presentation/registerUserController'
import { RegisterUser } from './usecase/registerUser'

/**
 * 依存を結線して、すぐ使えるコントローラを組み立てる。
 * 詳細(InMemoryUserRepository)をここで選び、内側の層へ注入する（依存性注入）。
 * @returns 結線済みの RegisterUserController
 */
export function buildRegisterUserController(): RegisterUserController {
  const repository = new InMemoryUserRepository()
  const registerUser = new RegisterUser(repository)
  return new RegisterUserController(registerUser)
}
