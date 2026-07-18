// 責務: 外部入力を RegisterUser ユースケースへ橋渡しする薄いアダプタ（プレゼンテーション）

import { RegisterUser } from '../usecase/registerUser'

/** コントローラが返す結果。プレゼンテーション層の関心（成否と表示用メッセージ）に閉じる。 */
export interface RegisterUserResult {
  ok: boolean
  message: string
}

/**
 * ユーザー登録のコントローラ。HTTP 等のプロトコル詳細をユースケースへ持ち込ませない。
 * ユースケースは注入され、この層は永続化実装(infrastructure)を直接は知らない。
 */
export class RegisterUserController {
  constructor(private readonly registerUser: RegisterUser) {}

  /**
   * 生の入力を受け取り登録を実行し、結果を表示用の形へ変換して返す。
   * @param rawInput id と email を含む入力
   * @returns 登録の成否と表示用メッセージ
   */
  async handle(rawInput: { id: string; email: string }): Promise<RegisterUserResult> {
    try {
      const user = await this.registerUser.execute({ id: rawInput.id, email: rawInput.email })
      return { ok: true, message: `registered: ${user.id.value}` }
    } catch (error) {
      return { ok: false, message: (error as Error).message }
    }
  }
}
