// 責務: 「開発者・運用者が直すまで解消しない失敗」を表す例外の基底型

/**
 * 技術的例外の基底クラス。
 * システム自体が壊れている失敗（外部接続断・到達不能パスなど）を表す。
 * 境界の集約 catch は分類漏れの未知エラーもこの性質として扱うため、利用者には内部詳細を返さない。
 */
export class TechnicalError extends Error {
  constructor(message: string) {
    super(message)
    // 既定では基底 Error の名前が入り、スタックトレースの先頭で種別を判別できなくなるため上書きする
    this.name = new.target.name
  }
}
