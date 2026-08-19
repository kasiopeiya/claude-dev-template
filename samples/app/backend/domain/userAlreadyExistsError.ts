// 責務: 「同一 ID のユーザーが既に登録されている」失敗を表す例外

import { BusinessError } from './businessError'
import { UserId } from './userId'

/**
 * 同一 ID のユーザーが既に存在するために登録できなかったことを表すビジネス例外。
 * 重複を検知するのは永続化の実装（複数ありうる）だが、文言はここへ集約して実装ごとにぶれさせない。
 */
export class UserAlreadyExistsError extends BusinessError {
  constructor(id: UserId) {
    super(`user already exists: ${id.value}`)
  }
}
