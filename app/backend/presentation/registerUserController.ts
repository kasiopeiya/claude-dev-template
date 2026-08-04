// 責務: 外部入力を RegisterUser ユースケースへ橋渡しする薄いアダプタ（プレゼンテーション）
// 前提: 内側の層は例外を投げっぱなしにするため、集約 catch はこの層だけが担う

import { BusinessError } from '../domain/businessError'
import { RegisterUser } from '../usecase/registerUser'

/** コントローラが返す結果。プレゼンテーション層の関心（成否と表示用メッセージ）に閉じる。 */
export interface RegisterUserResult {
  ok: boolean
  message: string
}

/** 技術的例外の集計・検索キー。メッセージ文言を変えても追跡が切れないよう、文言とは独立に持つ。 */
const REGISTER_USER_TECHNICAL_ERROR_CODE = 'REGISTER_USER_001'

/** 技術的例外のときに利用者へ返す文言。原因は利用者に直せないため、内部詳細を伏せて一律で返す。 */
const INTERNAL_ERROR_MESSAGE = 'internal error'

/**
 * 技術的例外を調査可能な形でログへ残す。
 * 利用者のメールアドレスは個人情報のため含めず、追跡はユーザーIDで行う。
 */
function logTechnicalError(userId: string, error: unknown): void {
  console.error(
    JSON.stringify({
      level: 'ERROR',
      message: 'ユーザー登録が技術的例外で失敗しました',
      errorCode: REGISTER_USER_TECHNICAL_ERROR_CODE,
      userId,
      error: error instanceof Error ? error.stack : String(error)
    })
  )
}

/**
 * ユーザー登録のコントローラ。HTTP 等のプロトコル詳細をユースケースへ持ち込ませない。
 * ユースケースは注入され、この層は永続化実装(infrastructure)を直接は知らない。
 */
export class RegisterUserController {
  constructor(private readonly registerUser: RegisterUser) {}

  /**
   * 生の入力を受け取り登録を実行し、結果を表示用の形へ変換して返す。
   * 失敗は例外の性質で振り分け、利用者が直せる失敗だけ理由を返す。
   * @param rawInput id と email を含む入力
   * @returns 登録の成否と表示用メッセージ
   */
  async handle(rawInput: { id: string; email: string }): Promise<RegisterUserResult> {
    try {
      const user = await this.registerUser.execute({ id: rawInput.id, email: rawInput.email })
      return { ok: true, message: `registered: ${user.id.value}` }
    } catch (error) {
      if (error instanceof BusinessError) {
        return { ok: false, message: error.message }
      }
      // 分類漏れの未知エラーも技術的例外として扱う（想定外＝壊れているはずなので安全側に倒す）
      logTechnicalError(rawInput.id, error)
      return { ok: false, message: INTERNAL_ERROR_MESSAGE }
    }
  }
}
