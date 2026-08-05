// 責務: UserRepository ポートのインメモリ実装（詳細）。テスト・ローカル用の差し替え可能なアダプタ

import { User } from '../domain/user'
import { UserAlreadyExistsError } from '../domain/userAlreadyExistsError'
import { UserId } from '../domain/userId'
import { UserRepository } from '../domain/userRepository'

/**
 * メモリ上に User を保持する UserRepository 実装。
 * 「詳細」であり DB 実装などへ差し替え可能。domain・usecase はこの存在を知らない。
 */
export class InMemoryUserRepository implements UserRepository {
  // 値オブジェクトはインスタンス同一性で照合されキーに使えないため、素の文字列(id.value)でキー化する
  private readonly userStore = new Map<string, User>()

  async findById(id: UserId): Promise<User | null> {
    return this.userStore.get(id.value) ?? null
  }

  async saveNewUser(user: User): Promise<void> {
    // 存在確認と格納の間に await を挟まない限り、単一スレッドの JS では他の保存が割り込めない＝原子的になる
    if (this.userStore.has(user.id.value)) {
      throw new UserAlreadyExistsError(user.id)
    }
    this.userStore.set(user.id.value, user)
  }
}
