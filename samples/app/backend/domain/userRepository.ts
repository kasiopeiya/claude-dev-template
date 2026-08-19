// 責務: User 永続化のポート（抽象）を定義する。保存先の詳細は infrastructure 層が担う

import { User } from './user'
import { UserId } from './userId'

/**
 * User を永続化・取得するためのポート。
 * usecase 層はこの抽象にのみ依存し、具体的な保存先（DB・外部API等）を知らない。
 */
export interface UserRepository {
  /** ID でユーザーを取得する。存在しなければ null を返す。 */
  findById(id: UserId): Promise<User | null>

  /**
   * 未登録のユーザーとして保存する。存在確認と保存は他の保存に割り込まれない一操作として行う。
   * 実装は存在確認と保存を分けず、保存先が備える原子的な操作（条件付き書き込み等）で満たすこと。
   * @param user 保存するユーザー
   * @throws {UserAlreadyExistsError} 同一 ID のユーザーが既に存在する場合
   */
  saveNewUser(user: User): Promise<void>
}
