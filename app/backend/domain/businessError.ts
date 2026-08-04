// 責務: 「利用者が入力・操作を直せば解消する失敗」を表す例外の基底型

/**
 * ビジネス例外の基底クラス。
 * システムは正常で、要求のほうが不正な失敗（バリデーション違反・ビジネスルール違反など）を表す。
 * 境界の集約 catch はこの型で技術的例外と振り分けるため、該当する失敗は必ずこの型を継承して投げる。
 */
export class BusinessError extends Error {
  constructor(message: string) {
    super(message)
    // 既定では基底 Error の名前が入り、スタックトレースの先頭で種別を判別できなくなるため上書きする
    this.name = new.target.name
  }
}
