// 責務: User を一意に識別する ID の値オブジェクト——空でないことを生成時に保証する

/**
 * User を一意に識別する ID を表す値オブジェクト。
 * `create` を通した非空の値だけが存在でき、生の string との取り違えも型で防ぐ（Primitive Obsession の回避）。
 */
export class UserId {
  private constructor(public readonly value: string) {}

  /**
   * UserId を生成する。空文字（空白のみを含む）の場合は生成を拒否する。
   * @param value ID 文字列
   * @returns 生成された UserId
   * @throws {Error} 空の場合
   */
  static create(value: string): UserId {
    if (value.trim() === '') {
      throw new Error('userId must not be empty')
    }
    return new UserId(value)
  }
}
