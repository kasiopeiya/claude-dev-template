// 責務: bashコマンド文字列を、クォートの内側を区切らずにステートメント・パイプ段へ分割する純粋関数のみを担う。
//
// 設計意図（WHY）:
// - クォートの内側は「実行されない文字列」であり、そもそも判定の対象ではない。ここを区切り文字として
//   扱うと、禁止コマンド名を本文に含むだけの正当な操作まで拒否してしまう（Issue #396）。
//   誤検知は hook にとって最も避けたい壊れ方なので、分割の段階で引用符を見る。
// - シェルの厳密なパース（サブシェル・変数展開・プロセス置換）はしない。hook はガードレールであって
//   完全な安全機構ではなく、判定できない入力は通す（fail-open）方針だからである。
//   引用符が閉じていない入力は、閉じるまでの全体を1つの塊として扱う（区切らない＝通す側に倒れる）。

// `<<<`（ヒアストリング）は中身が1行の文字列でヒアドキュメントではないため、前後の `<` で除外する
const HEREDOC_OPERATOR = /(?<!<)<<(?!<)-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/

// 単独の `&`（バックグラウンド実行）も区切る。これが無いと `echo x & git checkout -b y` の形で
// 後続コマンドを語頭から外し、判定をすり抜けさせられる
const STATEMENT_SEPARATORS = ['&&', '||', ';', '\n', '&']
// `||` を `|` より先に並べる。逆順だと `||` を空の段を挟む2つのパイプとして読んでしまう
const PIPE_SEPARATORS = ['||', '|']

const SINGLE_QUOTE = "'"
const DOUBLE_QUOTE = '"'

/**
 * その位置から始まる区切り文字を返す。区切りとして働かない `&` は除く。
 *
 * @param {string} text 分割対象のテキスト
 * @param {{ index: number, separators: string[] }} position 判定する位置と、候補の区切り文字
 * @returns {string | undefined} 見つかった区切り文字。無ければ undefined
 */
function findSeparatorAt(text, { index, separators }) {
  const separator = separators.find((candidate) => text.startsWith(candidate, index))
  if (separator !== '&') return separator

  // `&>` `>&`（出力のリダイレクト）の `&` はコマンドの区切りではない
  if (text[index + 1] === '>' || text[index - 1] === '>') return undefined
  return separator
}

/**
 * 引用符の内側を区切らずに、指定した区切り文字でテキストを分割する。
 *
 * @param {string} text 分割対象のテキスト
 * @param {string[]} separators 区切り文字（長いものを先に並べる）
 * @returns {string[]} 前後の空白を除いた、空でない断片の配列
 */
function splitOutsideQuotes(text, separators) {
  const segments = []
  let current = ''
  let openQuote = null
  let index = 0

  while (index < text.length) {
    const char = text[index]

    // シングルクォートの内側を除き、バックスラッシュは次の1文字を無効化する
    if (openQuote !== SINGLE_QUOTE && char === '\\') {
      current += char + (text[index + 1] ?? '')
      index += 2
      continue
    }

    if (openQuote === null && (char === SINGLE_QUOTE || char === DOUBLE_QUOTE)) {
      openQuote = char
    } else if (openQuote === char) {
      openQuote = null
    } else if (openQuote === null) {
      const separator = findSeparatorAt(text, { index, separators })
      if (separator) {
        segments.push(current)
        current = ''
        index += separator.length
        continue
      }
    }

    current += char
    index++
  }

  segments.push(current)
  return segments.map((segment) => segment.trim()).filter(Boolean)
}

/**
 * ヒアドキュメントの中身を、コマンド本体から切り離す。
 *
 * 中身は実行されない入力データであり、区切り文字も禁止コマンド名も含みうるので、
 * 分割・判定の前に外す。ヒアドキュメントが複数ある場合、切り離すのは最初の1つだけ。
 *
 * @param {string} command bashコマンド文字列
 * @returns {{ commandText: string, heredocBody: string | null }} 中身を除いたコマンド本体と、
 *   ヒアドキュメントの中身（無ければ null）
 */
export function splitHeredoc(command) {
  if (typeof command !== 'string') return { commandText: '', heredocBody: null }

  const lines = command.split('\n')
  const operatorIndex = lines.findIndex((line) => HEREDOC_OPERATOR.test(line))
  if (operatorIndex === -1) return { commandText: command, heredocBody: null }

  const delimiter = HEREDOC_OPERATOR.exec(lines[operatorIndex])[2]
  const bodyStart = operatorIndex + 1
  let terminatorIndex = lines.findIndex((line, i) => i >= bodyStart && line.trim() === delimiter)
  if (terminatorIndex === -1) terminatorIndex = lines.length

  return {
    commandText: [...lines.slice(0, bodyStart), ...lines.slice(terminatorIndex + 1)].join('\n'),
    heredocBody: lines.slice(bodyStart, terminatorIndex).join('\n')
  }
}

/**
 * コマンド文字列を、順に実行される単位（ステートメント）へ分割する。
 *
 * @param {string} command bashコマンド文字列
 * @returns {string[]} `&&` `||` `;` 改行で区切られたステートメント
 */
export function splitStatements(command) {
  if (typeof command !== 'string') return []
  return splitOutsideQuotes(command, STATEMENT_SEPARATORS)
}

/**
 * ステートメントを、パイプでつながれた段へ分割する。
 *
 * @param {string} statement ステートメント
 * @returns {string[]} `|` で区切られた段（左から順）
 */
export function splitPipeStages(statement) {
  if (typeof statement !== 'string') return []
  return splitOutsideQuotes(statement, PIPE_SEPARATORS)
}
