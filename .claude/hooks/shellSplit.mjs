// 責務: bashコマンド文字列を、判定できる単位（ステートメント・パイプ段・トークン）へ分解する
// 純粋関数のみを担う。クォートの内側は区切らない。
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

// コマンド本体の前に置かれ、後続を実行するだけのトークン。剥がしてから語頭を判定する
const COMMAND_WRAPPERS = new Set(['sudo', 'env', 'npx', 'command', 'time', 'nohup'])
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

// サブコマンドの前にグローバルオプションを置けるコマンドと、そのうち値を伴うフラグ。
// gh は `--repo` を「サブコマンドのフラグ」として説明しているが、実際にはサブコマンドの前でも
// 受け付ける（`gh --repo owner/repo issue list` が通ることを実行して確認）
export const GLOBAL_VALUE_FLAGS = {
  git: new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']),
  gh: new Set(['-R', '--repo', '--hostname'])
}

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
 * ヒアドキュメントの中身を、すべてコマンド本体から切り離す。
 *
 * 中身は実行されない入力データであり、区切り文字も禁止コマンド名も含みうるので、
 * 分割・判定の前に外す。中身は書かれた順に返すので、呼び出し側は
 * `countHeredocOperators` で数えた順番で対応づける（1つ目の中身を2つ目の判定に使うと、
 * 空かどうかが入れ替わる）。
 *
 * @param {string} command bashコマンド文字列
 * @returns {{ commandText: string, heredocBodies: string[] }} 中身を除いたコマンド本体と、
 *   書かれた順のヒアドキュメントの中身（無ければ空配列）
 */
export function splitHeredoc(command) {
  if (typeof command !== 'string') return { commandText: '', heredocBodies: [] }

  const lines = command.split('\n')
  const commandLines = []
  const heredocBodies = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]
    commandLines.push(line)
    index++

    const operator = HEREDOC_OPERATOR.exec(line)
    if (!operator) continue

    const bodyStart = index
    while (index < lines.length && lines[index].trim() !== operator[2]) index++
    heredocBodies.push(lines.slice(bodyStart, index).join('\n'))
    index++ // 終端行そのものはコマンド本体に残さない
  }

  return { commandText: commandLines.join('\n'), heredocBodies }
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

/**
 * ステートメントを空白で区切り、トークンの配列にする。
 *
 * @param {string} statement ステートメント（またはパイプ段）
 * @returns {string[]} 空文字を除いたトークン
 */
export function tokenize(statement) {
  if (typeof statement !== 'string') return []
  return statement.split(/\s+/).filter(Boolean)
}

/**
 * トークンを囲む引用符を外す。囲まれていなければそのまま返す。
 *
 * @param {string} value トークン
 * @returns {string} 引用符を外した値
 */
export function stripQuotes(value) {
  if (typeof value !== 'string') return value
  if (value.length >= 2 && value[0] === value.at(-1) && (value[0] === '"' || value[0] === "'")) {
    return value.slice(1, -1)
  }
  return value
}

/**
 * ヒアドキュメントの開始演算子（`<<EOF`）の個数を数える。
 * `splitHeredoc` が返す中身を「何番目のヒアドキュメントか」で対応づけるために使う。
 *
 * @param {string} text 判定するテキスト
 * @returns {number} 開始演算子の個数
 */
export function countHeredocOperators(text) {
  if (typeof text !== 'string') return 0
  return [...text.matchAll(new RegExp(HEREDOC_OPERATOR.source, 'g'))].length
}

/**
 * コマンド名とサブコマンドの間に挟まったグローバルオプションを取り除く。
 *
 * 取り除かないと `git -C /tmp checkout -b x`・`gh --repo o/r issue edit 1` のように
 * サブコマンドの位置がずれ、位置で読む判定がすべて外れる。
 * グローバルオプションを持たないコマンドはそのまま返す。
 *
 * @param {string[]} tokens 語頭から並んだトークン
 * @returns {string[]} コマンド名の直後がサブコマンドになるよう詰めたトークン
 */
export function stripGlobalOptions(tokens) {
  if (!Array.isArray(tokens)) return tokens

  const valueFlags = GLOBAL_VALUE_FLAGS[tokens[0]]
  if (!valueFlags) return tokens

  const rest = tokens.slice(1)
  let index = 0
  while (index < rest.length && rest[index].startsWith('-')) {
    if (valueFlags.has(rest[index])) index++
    index++
  }
  return [tokens[0], ...rest.slice(index)]
}

/**
 * 実際に実行されるコマンドが先頭に来るよう、語頭を正規化する。
 *
 * 環境変数の代入（`FOO=1`）・ラッパーコマンド（`env` `sudo` `npx` など）・
 * グローバルオプション（`git -C <path>`・`gh --repo <o/r>`）を剥がす。
 * 剥がさないと `env git checkout -b x` のように、語頭を1語ずらすだけで判定を外せる。
 *
 * @param {string[]} tokens 語頭から並んだトークン
 * @returns {string[]} 実行されるコマンド名が先頭に来るトークン
 */
export function normalizeCommandStart(tokens) {
  if (!Array.isArray(tokens)) return tokens

  let index = 0
  while (index < tokens.length) {
    if (ENV_ASSIGNMENT.test(tokens[index])) {
      index++
      continue
    }
    if (!COMMAND_WRAPPERS.has(tokens[index])) break

    index++
    // ラッパー自身のフラグ（`npx -y` など）も読み飛ばす
    while (index < tokens.length && tokens[index].startsWith('-')) index++
  }
  return stripGlobalOptions(tokens.slice(index))
}
