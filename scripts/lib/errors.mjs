// 責務: scripts/ の各 .mjs が投げる失敗を「誰が解消するか」で2種に分ける基底クラスだけを担う。
//
// 設計意図（WHY）:
// - 素の Error を直に投げると、境界の catch が「処理を続けられない故障」と「利用者が直せば済む誤り」を見分けられない。
//   application-design-policy「例外は2種に分ける」に従い、scripts/ も投げる失敗をどちらかに属させる。
// - 各スクリプトが同じ2クラスを使い、境界が instanceof で振り分けられるよう、定義を1か所に置く。
// - 個別のサブクラスはここに足さず、投げる側のモジュールで作る（作る条件は同ポリシーの同じ節）。
// - name を上書きするのは、既定のままだとスタックトレースの先頭が `Error: ...` になり、境界が出す表示から種類が消えるため。

/** 処理を続けられない失敗。直すのは開発者・運用者（コードや設定の修正・環境の復旧）。 */
export class TechnicalError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = new.target.name
  }
}

/** 利用者の入力・操作が不正なために、わざと投げる失敗。直すのは利用者（コマンドの引数や、読ませる文書の書き方を誤った人）。 */
export class BusinessError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = new.target.name
  }
}
