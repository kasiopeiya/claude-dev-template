// 責務: User 永続化のポート（抽象）を定義する。保存先の詳細は infrastructure 層が担う

import { User, UserId } from './user'

/**
 * User を永続化・取得するためのポート。
 * usecase 層はこの抽象にのみ依存し、具体的な保存先（DB・外部API等）を知らない。
 */
export interface UserRepository {
  /** ID でユーザーを取得する。存在しなければ null を返す。 */
  findById(id: UserId): Promise<User | null>

  /** ユーザーを保存する。 */
  save(user: User): Promise<void>
}
