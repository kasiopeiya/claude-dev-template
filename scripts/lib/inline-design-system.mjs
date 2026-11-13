// 責務: HTML がローカルの相対パスで読む CSS・JS を、同じ位置で `<style>`・`<script>` に置き換えた HTML を返すことだけを担う。
//   ファイルへの書き出しは呼び出し側（scripts/export-standalone-html.mjs など）が行う。
//
// 設計意図（WHY）:
// - 同じ位置で置き換える。読み込みの順は動作に効く。design-system の math-copy.js は window.MathJax を定義するので、
//   MathJax を読む `<script async>` より前で動かないと設定が効かない。まとめて <head> の先頭や末尾に移すと順が崩れる。
// - 置換先は関数で渡す。String.prototype.replace に文字列で渡すと `$'`・`$&` などが特殊パターンとして解釈され、
//   math-copy.js の `'$'` のような中身が壊れる。関数の戻り値はそのまま使われる。
// - 埋め込むのは、`<link>` からは `.css`、`<script>` からは `.js` のファイルだけにする。出力は外へ配る1枚なので、
//   参照に `.env` や鍵のパスが書かれていると、中身が気づかれないまま配られる。
// - 次のときは、何も返さずに例外を投げて止まる。壊れた1枚を書き出すと、配った先で崩れて初めて気づくことになるため。
//   - 参照先のファイルが無いとき・拡張子が違うとき
//   - 既定では効かないスタイルシート（rel に alternate を含む・disabled を持つ）を読むとき。`<style>` にすると常に効く
//   - 置き換えた後も、ローカルの CSS・JS の参照が残るとき。置き換えより緩い条件で探すので、置き換えが拾えなかった書き方
//     （rel の無い .css の参照など）を見逃さない
//   - 埋め込む中身がブロックを途中で閉じうるとき。WHATWG HTML は、`</style`・`</script` が（大文字小文字を問わず）
//     空白・`/`・`>` を伴うと閉じると定め、`<script>` の中の `<!--`・`<script` も対になっていないと閉じなくなると定める。
//     ここでは仕様より厳しく、CSS に `</style`、JS に `</script`・`<!--`・`<script` が現れたら止める。現物のどれにも無く、
//     迷う余地を残さないほうが安い
// - 外部の URL（`http:`・`https:`・`//`・`data:` など、スキームか `//` で始まるもの）は置き換えない。オンラインで開ければよいと決めたため。

import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

import { BusinessError } from './errors.mjs'

const LINK_TAG_PATTERN = /<link\b([^>]*)>/gi
const SCRIPT_ELEMENT_PATTERN = /<script\b([^>]*)>[\s\S]*?<\/script\s*>/gi
const SCRIPT_START_TAG_PATTERN = /<script\b([^>]*)>/gi
const ATTRIBUTE_PATTERN = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
const REMOTE_URL_PATTERN = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i

const FORBIDDEN_STYLE_CONTENT_PATTERNS = [/<\/style/i]
const FORBIDDEN_SCRIPT_CONTENT_PATTERNS = [/<\/script/i, /<!--/, /<script/i]

/**
 * HTML がローカルの相対パスで読む CSS・JS を、同じ位置で `<style>`・`<script>` に置き換えた HTML を返す。
 *
 * @param {{ htmlText: string, baseDirectoryPath: string }} inlineRequest 置き換える前の HTML と、相対パスを解く基準のフォルダ
 * @returns {string} ローカルの CSS・JS を埋め込んだ HTML
 * @throws {BusinessError} 参照先のファイルが無い・拡張子が違うとき・既定では効かないスタイルシートを読むとき・置き換えた後もローカルの参照が残るとき・埋め込む中身がブロックを途中で閉じうるとき
 */
export function inlineLocalStylesAndScripts({ htmlText, baseDirectoryPath }) {
  const styleInlinedHtml = htmlText.replace(LINK_TAG_PATTERN, (linkTag, attributeText) =>
    inlineLinkTag({ linkTag, attributeText, baseDirectoryPath })
  )
  const inlinedHtml = styleInlinedHtml.replace(
    SCRIPT_ELEMENT_PATTERN,
    (scriptElement, attributeText) =>
      inlineScriptElement({ scriptElement, attributeText, baseDirectoryPath })
  )
  assertNoLocalReferenceRemains(inlinedHtml)
  return inlinedHtml
}

/**
 * `<link>` がローカルのスタイルシートを読むなら `<style>` に置き換え、そうでなければそのまま返す。
 *
 * @param {{ linkTag: string, attributeText: string, baseDirectoryPath: string }} linkTagMatch
 *   `<link …>` のタグ全体・タグ名の後ろの属性の部分・相対パスを解く基準のフォルダ
 * @returns {string} 置き換えた後のタグ
 * @throws {BusinessError} 既定では効かないスタイルシートのとき・参照先のファイルが無い・`.css` でないとき・中身に `</style` があるとき
 */
function inlineLinkTag({ linkTag, attributeText, baseDirectoryPath }) {
  const attributes = parseAttributes(attributeText)
  const stylesheetHref = attributes.get('href')
  if (!isStylesheetLink(attributes) || !isLocalReference(stylesheetHref)) {
    return linkTag
  }
  if (readRelTokens(attributes).includes('alternate') || attributes.has('disabled')) {
    throw new BusinessError(
      `${stylesheetHref} は既定では効かないスタイルシートで、埋め込むと常に効きます。rel の alternate・disabled を外してください`
    )
  }
  const styleText = readReferencedFile({
    reference: stylesheetHref,
    baseDirectoryPath,
    embeddableExtension: '.css'
  })
  assertContentKeepsBlockOpen({
    contentText: styleText,
    forbiddenPatterns: FORBIDDEN_STYLE_CONTENT_PATTERNS,
    reference: stylesheetHref
  })
  const mediaAttribute = attributes.has('media') ? ` media="${attributes.get('media')}"` : ''
  return `<style${mediaAttribute}>\n${styleText}\n</style>`
}

/**
 * `<script src>` がローカルの JS を読むなら中身を埋め込んだ `<script>` に置き換え、そうでなければそのまま返す。
 * src 以外の属性（type など）は残す。async・defer はインラインのスクリプトでは効かず、その位置で実行される。
 *
 * @param {{ scriptElement: string, attributeText: string, baseDirectoryPath: string }} scriptElementMatch
 *   `<script …></script>` の要素全体・開始タグの属性の部分・相対パスを解く基準のフォルダ
 * @returns {string} 置き換えた後の要素
 * @throws {BusinessError} 参照先のファイルが無い・`.js` でないとき・中身がブロックを途中で閉じうるとき
 */
function inlineScriptElement({ scriptElement, attributeText, baseDirectoryPath }) {
  const attributes = parseAttributes(attributeText)
  const scriptSource = attributes.get('src')
  if (!isLocalReference(scriptSource)) {
    return scriptElement
  }
  const scriptText = readReferencedFile({
    reference: scriptSource,
    baseDirectoryPath,
    embeddableExtension: '.js'
  })
  assertContentKeepsBlockOpen({
    contentText: scriptText,
    forbiddenPatterns: FORBIDDEN_SCRIPT_CONTENT_PATTERNS,
    reference: scriptSource
  })
  const keptAttributeText = [...attributes]
    .filter(([attributeName]) => attributeName !== 'src')
    .map(([attributeName, attributeContent]) =>
      attributeContent === '' ? ` ${attributeName}` : ` ${attributeName}="${attributeContent}"`
    )
    .join('')
  return `<script${keptAttributeText}>\n${scriptText}\n</script>`
}

/**
 * 置き換えた後の HTML に、ローカルの CSS・JS の参照が残っていないことを確かめる。
 * 置き換えより緩く、rel を問わず `.css` を読む `<link>` と、src を持つ `<script>` を探す。
 *
 * @param {string} inlinedHtml 置き換えた後の HTML
 * @throws {BusinessError} ローカルの参照が残っているとき
 */
function assertNoLocalReferenceRemains(inlinedHtml) {
  const remainingReferences = [
    ...[...inlinedHtml.matchAll(LINK_TAG_PATTERN)]
      .map(([, attributeText]) => parseAttributes(attributeText))
      .filter(
        (attributes) =>
          isStylesheetLink(attributes) || /\.css(?:[?#]|$)/i.test(attributes.get('href') ?? '')
      )
      .map((attributes) => attributes.get('href')),
    ...[...inlinedHtml.matchAll(SCRIPT_START_TAG_PATTERN)].map(([, attributeText]) =>
      parseAttributes(attributeText).get('src')
    )
  ].filter(isLocalReference)
  if (remainingReferences.length > 0) {
    throw new BusinessError(
      `置き換えた後も、ローカルの CSS・JS の参照が残っています（${remainingReferences.join('、')}）。タグの書き方を確かめてください`
    )
  }
}

/**
 * 埋め込む中身に、ブロックを途中で閉じうる文字列が無いことを確かめる。
 *
 * @param {{ contentText: string, forbiddenPatterns: RegExp[], reference: string }} embeddedContent
 *   埋め込む中身・止める文字列の正規表現・参照のパス（メッセージに使う）
 * @throws {BusinessError} 止める文字列が現れたとき
 */
function assertContentKeepsBlockOpen({ contentText, forbiddenPatterns, reference }) {
  const matchedPattern = forbiddenPatterns.find((forbiddenPattern) =>
    forbiddenPattern.test(contentText)
  )
  if (matchedPattern) {
    throw new BusinessError(
      `${reference} の中身に ${matchedPattern.source.replace(/\\/g, '')} があり、埋め込むとブロックが途中で閉じます`
    )
  }
}

/**
 * 参照先のファイルを、基準のフォルダから解いて読む。`?` 以降と `#` 以降は落とし、パーセントエンコードは戻す。
 *
 * @param {{ reference: string, baseDirectoryPath: string, embeddableExtension: string }} fileReference
 *   HTML に書かれた参照のパス・相対パスを解く基準のフォルダ・埋め込んでよい拡張子（`.css` など）
 * @returns {string} ファイルの中身
 * @throws {BusinessError} 拡張子が違うとき・参照先のファイルが無いとき
 */
function readReferencedFile({ reference, baseDirectoryPath, embeddableExtension }) {
  const referencedFilePath = path.resolve(
    baseDirectoryPath,
    decodePercentEncodingLikeBrowser(reference.replace(/[?#].*$/, ''))
  )
  if (path.extname(referencedFilePath).toLowerCase() !== embeddableExtension) {
    throw new BusinessError(
      `${embeddableExtension} 以外のファイルは埋め込みません（${reference} → ${referencedFilePath}）`
    )
  }
  if (!existsSync(referencedFilePath) || !statSync(referencedFilePath).isFile()) {
    throw new BusinessError(`参照先のファイルがありません（${reference} → ${referencedFilePath}）`)
  }
  return readFileSync(referencedFilePath, 'utf8')
}

/**
 * パーセントエンコードを戻す。`100%.css` のように戻せない `%` があれば、ブラウザと同じく元の文字列のまま使う。
 *
 * @param {string} referencePath `?`・`#` を落とした参照のパス
 * @returns {string} 戻したパス
 */
function decodePercentEncodingLikeBrowser(referencePath) {
  try {
    return decodeURIComponent(referencePath)
  } catch {
    return referencePath
  }
}

/**
 * タグの属性の部分を、小文字の属性名から値への Map にする。値の前後の空白は、ブラウザと同じく落とす。値の無い属性は空文字にする。
 *
 * @param {string} attributeText 開始タグのうち、タグ名の後ろの部分
 * @returns {Map<string, string>} 属性名から値への Map
 */
function parseAttributes(attributeText) {
  return new Map(
    [...attributeText.matchAll(ATTRIBUTE_PATTERN)].map(
      ([, attributeName, doubleQuoted, singleQuoted, unquoted]) => [
        attributeName.toLowerCase(),
        (doubleQuoted ?? singleQuoted ?? unquoted ?? '').trim()
      ]
    )
  )
}

/**
 * @param {Map<string, string>} attributes `<link>` の属性
 * @returns {string[]} rel の語（小文字）
 */
function readRelTokens(attributes) {
  return (attributes.get('rel') ?? '').toLowerCase().split(/\s+/)
}

/**
 * @param {Map<string, string>} attributes `<link>` の属性
 * @returns {boolean} rel に stylesheet を含むか
 */
function isStylesheetLink(attributes) {
  return readRelTokens(attributes).includes('stylesheet')
}

/**
 * @param {string | undefined} reference href・src の値
 * @returns {boolean} ローカルのファイルを指すか（空でなく、スキームでも `//` でも始まらない）
 */
function isLocalReference(reference) {
  return typeof reference === 'string' && reference !== '' && !REMOTE_URL_PATTERN.test(reference)
}
