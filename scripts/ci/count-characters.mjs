// 責務: 文字数上限の検査（check-*-size.mjs）が使う、文字の数え方をここ1か所に集める。
//   数え方が検査ごとにずれると、上限どうしの値を比べられなくなる。

/**
 * `wc -m` と同じ数え方で文字数を返す（コードポイント単位。UTF-16 の符号単位ではない）。
 *
 * @param {string} text 数える対象
 * @returns {number} 文字数
 */
export function countCharacters(text) {
  return [...text].length
}
