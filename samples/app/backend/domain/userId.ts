// 責務: User を一意に識別する ID の値オブジェクト——空でないことを生成時に保証する

import { BusinessError } from './businessError'

/**
 * User を一意に識別する ID を表す値オブジェクト。
 * `create` を通した非空の値だけが存在でき、生の string との取り違えも型で防ぐ（Primitive Obsession の回避）。
 */
export class UserId {
  private constructor(public readonly value: string) {}

  /**
   * UserId を生成する。前後の空白は取り除いて保持し、空文字（空白のみを含む）の場合は生成を拒否する。
   * @param value ID 文字列
   * @returns 生成された UserId
   * @throws {BusinessError} 空の場合
   */
  static create(value: string): UserId {
    // 空白の有無だけが違う値を別 ID にしないため、判定だけでなく保持する値も trim 済みに揃える
    const trimmedValue = value.trim()
    if (trimmedValue === '') {
      throw new BusinessError('userId must not be empty')
    }
    return new UserId(trimmedValue)
  }
}
