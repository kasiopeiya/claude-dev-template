// 責務: frontmatter から YAML の配列値を読み出すことと、glob を正規表現にすることを担う。
//
// 設計意図（WHY）:
// - Policy の `applies-to` と Rule の `paths` は、キー名が違うだけで書式の解析ロジックは同一。
//   ここに集約し、policyMatcher.mjs と ruleMatcher.mjs が重複した実装を持たないようにする。

/**
 * glob を行頭〜行末アンカーの正規表現へ変換する。`**` はディレクトリ跨ぎ、`*` は単一階層内。
 * `?`・`{a,b}`・`[...]` は解釈せず、文字どおりにマッチさせる（未対応）。
 */
export function convertGlobToRegExp(glob) {
  let pattern = ''
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]
    if (char === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') {
          i++
          pattern += '(?:.*/)?'
        } else {
          pattern += '.*'
        }
      } else {
        pattern += '[^/]*'
      }
    } else if ('.+?^${}()|[]\\'.includes(char)) {
      pattern += '\\' + char
    } else {
      pattern += char
    }
  }
  return new RegExp('^' + pattern + '$')
}

/** 先頭の frontmatter（`---` に挟まれた内側）を取り出す。無ければ null。改行は LF のみ認識する。 */
export function extractFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---/)
  return match ? match[1] : null
}

/**
 * frontmatter テキストから、指定したキーのグロブ配列を抜き出す（YAML依存なしの最小実装）。
 * インライン配列（1行・複数行）・ブロックシーケンス・単一スカラーの4形式に対応する。
 * `key:` が書かれているのに1件も返せない「沈黙」を防ぐため、書式差を吸収する。
 * 複数行インライン配列は prettier が printWidth 超過時に自動生成する形なので、必ず読めること。
 *
 * キーが無ければ []。インデントを問わず、最初に現れた `key:` 行を読む。
 * 事前条件：key は正規表現の記号を含まない。インライン配列の値はカンマを含まない。
 */
export function parseFrontmatterList(frontmatter, key) {
  const lines = frontmatter.split('\n')
  const keyPattern = new RegExp(`^\\s*${key}:`)
  const keyLineIndex = lines.findIndex((line) => keyPattern.test(line))
  if (keyLineIndex === -1) return []

  const value = lines[keyLineIndex].replace(new RegExp(`^\\s*${key}:\\s*`), '').trim()

  // インライン配列: key: ['a', 'b']（値が同じ行にある場合）
  if (value.startsWith('[')) {
    return splitInline(joinBracketed(lines, keyLineIndex))
  }
  // インライン単一スカラー: key: '**/*.md'
  if (value) return [stripQuotes(value)]

  // 複数行インライン配列: key: の次行が `[` で始まり、`]` の行まで続く
  if (lines[keyLineIndex + 1]?.trim().startsWith('[')) {
    return splitInline(joinBracketed(lines, keyLineIndex + 1))
  }

  // ブロックシーケンス: 後続の `- item` 行を、リスト項目でない行に当たるまで集める
  const items = []
  for (let i = keyLineIndex + 1; i < lines.length; i++) {
    const itemMatch = lines[i].match(/^\s*-\s*(.+?)\s*$/)
    if (!itemMatch) break
    items.push(stripQuotes(itemMatch[1]))
  }
  return items
}

/** startLineIndex 行から `]` の行までを連結し、角括弧の内側テキストを返す。閉じ括弧が無ければ末尾まで。 */
function joinBracketed(lines, startLineIndex) {
  let joined = ''
  for (let i = startLineIndex; i < lines.length; i++) {
    joined += lines[i].trim()
    if (lines[i].includes(']')) break
  }
  return joined.replace(/^[^[]*\[/, '').replace(/\].*$/, '')
}

function splitInline(inner) {
  return inner
    .split(',')
    .map((rawValue) => stripQuotes(rawValue.trim()))
    .filter(Boolean)
}

function stripQuotes(rawValue) {
  return rawValue.replace(/^["']|["']$/g, '')
}
