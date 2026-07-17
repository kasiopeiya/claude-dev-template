// 責務: UserRepository ポートのインメモリ実装（詳細）。テスト・ローカル用の差し替え可能なアダプタ

import { User, UserId } from '../domain/user'
import { UserRepository } from '../domain/userRepository'

/**
 * メモリ上に User を保持する UserRepository 実装。
 * 「詳細」であり DB 実装などへ差し替え可能。domain・usecase はこの存在を知らない。
 */
export class InMemoryUserRepository implements UserRepository {
  private readonly userStore = new Map<UserId, User>()

  async findById(id: UserId): Promise<User | null> {
    return this.userStore.get(id) ?? null
  }

  async save(user: User): Promise<void> {
    this.userStore.set(user.id, user)
  }
}
