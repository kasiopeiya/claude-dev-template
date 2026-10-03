// 責務: 着手できない周が続いた回数から、まだ待つか止めるかを決める純粋関数と、その上限の検査だけを担う。
//
// 設計意図（WHY）:
// - 放置したまま見直し続けると、1周ごとに呼ぶ gh の呼び出しが積み上がり、GitHub API のレート制限に触れる。
//   待つ回数に上限を置き、超えたら待たずに止める。
// - 上限は config.mjs の設定値だが、config.mjs はテンプレート同期の対象外なので、利用先では欠けたまま
//   動くことがある。欠けたままだと上限が undefined になり、止まらないか最初の空振りで止まる。
//   どちらも気づきにくいので、起動時に検査して落とす（configuration-policy の fail-fast）。
// - I/O を持たない層をここに切り出すことで、待機ループに触れずに単体テストできる。

/**
 * 着手できない周が続いた回数から、次にすること（待つ・止める）を決める。
 *
 * @param {{ idlePollCount: number, maxConsecutiveIdleWaits: number }} params 連続して着手しなかった回数（今回を含む）と、待ってよい回数の上限
 * @returns {'wait' | 'stop'} 上限までなら待つ。上限を超えたら待たずに止める
 */
export function decideAfterIdlePoll({ idlePollCount, maxConsecutiveIdleWaits }) {
  return idlePollCount <= maxConsecutiveIdleWaits ? 'wait' : 'stop'
}

/**
 * 待ってよい回数の上限が、1以上の整数であることを確かめる。
 *
 * @param {unknown} maxConsecutiveIdleWaits config.mjs の `maxConsecutiveIdleWaits`
 * @returns {void}
 * @throws {Error} 上限が欠けている・1以上の整数でないとき
 */
export function validateMaxConsecutiveIdleWaits(maxConsecutiveIdleWaits) {
  if (Number.isInteger(maxConsecutiveIdleWaits) && maxConsecutiveIdleWaits >= 1) return
  throw new Error(
    `scripts/auto-programmer/config.mjs の maxConsecutiveIdleWaits は1以上の整数で指定してください（いまの値: ${String(maxConsecutiveIdleWaits)}）。着手できない周が続いたとき、待ってよい回数の上限です`
  )
}
