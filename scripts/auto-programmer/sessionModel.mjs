// 責務: 無人の claude セッションに渡すモデルと effort の設定を検査し、`claude` の引数に組み立てる。
//
// 設計意図（WHY）:
// - 値を渡さないと、セッションは ~/.claude/settings.json を継ぐ。人間が対話で /model を打つとそこが
//   書き換わるので、無人実行のモデルが人間の最後の選択に引きずられる（Issue #1218）。
// - 欠けた設定は、Issue を拾う前に止める。config.mjs はテンプレート同期の対象外で、同期した利用先では欠けうる。
//   黙って settings.json に任せると、引きずられる元の振る舞いに戻ったことに気づけない。
// - 値の中身（モデル名・effort の段階）は検査しない。使える値は claude の版で変わるので、claude 自身に任せる。

import { TechnicalError } from '../lib/errors.mjs'

/**
 * モデルと effort の設定が、どちらも空でない文字列であることを確かめる。
 *
 * @param {{ sessionModel: unknown, sessionEffort: unknown }} settings config.mjs の `sessionModel`・`sessionEffort`
 * @returns {void}
 * @throws {TechnicalError} どちらかが欠けている・空文字・文字列でないとき
 */
export function validateSessionModelSettings({ sessionModel, sessionEffort }) {
  for (const [keyName, settingText] of [
    ['sessionModel', sessionModel],
    ['sessionEffort', sessionEffort]
  ]) {
    if (typeof settingText === 'string' && settingText !== '') continue
    throw new TechnicalError(
      `scripts/auto-programmer/config.mjs の ${keyName} を空でない文字列で指定してください（いまの値: ${String(settingText)}）。無人の claude セッションに --model・--effort として渡す値です`
    )
  }
}

/**
 * モデルと effort を、`claude` に渡す引数に組み立てる。
 *
 * @param {{ sessionModel: string, sessionEffort: string }} settings config.mjs の `sessionModel`・`sessionEffort`
 * @returns {string[]} `['--model', <モデル>, '--effort', <effort>]`
 */
export function buildSessionModelArgs({ sessionModel, sessionEffort }) {
  return ['--model', sessionModel, '--effort', sessionEffort]
}
