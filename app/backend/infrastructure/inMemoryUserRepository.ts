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

  // メモリ操作に待つものがないため、async にせず Promise を直接返す
  findById(id: UserId): Promise<User | null> {
    return Promise.resolve(this.userStore.get(id.value) ?? null)
  }

  saveNewUser(user: User): Promise<void> {
    // 存在確認と格納の間に await を挟まない限り、単一スレッドの JS では他の保存が割り込めない＝原子的になる
    if (this.userStore.has(user.id.value)) {
      // async でないため throw は同期例外になり呼び出し側の捕捉経路が変わる。reject で返す
      return Promise.reject(new UserAlreadyExistsError(user.id))
    }
    this.userStore.set(user.id.value, user)
    return Promise.resolve()
  }
}
