// 責務: bashコマンド文字列から「`ai-fixable` / `issue:needs-human-decision` のどちらも付けない
// `gh issue create` 呼び出し」を検出する純粋関数のみを担う。
//
// 設計意図（WHY）:
// - この2ラベルは排他で、必ずどちらか一方が付く決まり（.claude/skills/quick-issue/SKILL.md）。
//   どちらも無い Issue は `/sweep` の一斉対応からも人間の個別相談からも漏れ、誰の目にも触れないまま残る。
// - 守らせているのが文章のルールだけだと、読み落とせば発火しない。実行前に機械的に止める。
// - ヒアドキュメントの中身は本文であって、コマンドの一部ではない。Issue 本文にはラベル名そのものが
//   書かれることがあるため、先に切り離さないと「ラベルが付いている」と誤判定する。
// - シェルの厳密なパース（クォート・サブシェル・変数展開）はしない。判定できない入力は通す（fail-open）。

const HEREDOC_OPERATOR = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/

const LABEL_FLAGS = ['-l', '--label']
const REQUIRED_LABELS = ['ai-fixable', 'issue:needs-human-decision']

/**
 * ヒアドキュメントの中身を落とし、コマンド本体だけを残す。
 * 本文にはパイプや `;` を含む Markdown 表が入りうるため、先に落とさないとコマンドの区切りを誤る。
 */
function stripHeredocBodies(command) {
  const lines = command.split('\n')
  const kept = []
  let terminator = null

  for (const line of lines) {
    if (terminator !== null) {
      if (line.trim() === terminator) terminator = null
      continue
    }
    kept.push(line)
    const match = HEREDOC_OPERATOR.exec(line)
    if (match) terminator = match[2]
  }

  return kept.join('\n')
}

// `\` で終わる行は次の行へ続く。先に繋がないと、複数行に分けて書かれた
// `gh issue create` とその `--label` が別のコマンドとして扱われる。
function joinLineContinuations(commandText) {
  return commandText.replace(/\\\n/g, ' ')
}

function splitStatements(commandText) {
  return commandText
    .split(/&&|\|\||\||;|\n/)
    .map((statement) => statement.trim())
    .filter(Boolean)
}

function tokenize(statement) {
  return statement.split(/\s+/).filter(Boolean)
}

function stripQuotes(value) {
  if (value.length >= 2 && value[0] === value.at(-1) && (value[0] === '"' || value[0] === "'")) {
    return value.slice(1, -1)
  }
  return value
}

function isIssueCreate(tokens) {
  return tokens[0] === 'gh' && tokens[1] === 'issue' && tokens[2] === 'create'
}

/**
 * `--label a,b` `--label=a` `-l a` のいずれの書き方でも、指定されたラベル名を集める。
 */
function collectLabels(tokens) {
  const labels = []

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (!token.startsWith('-')) continue

    const equalIndex = token.indexOf('=')
    const [flag, rawValue] =
      equalIndex === -1
        ? [token, tokens[i + 1]]
        : [token.slice(0, equalIndex), token.slice(equalIndex + 1)]

    if (!LABEL_FLAGS.includes(flag) || rawValue === undefined) continue

    for (const label of stripQuotes(rawValue).split(',')) {
      const trimmed = label.trim()
      if (trimmed) labels.push(trimmed)
    }
  }

  return labels
}

/**
 * bashコマンド文字列を検査し、必須ラベルを欠いた `gh issue create` があれば
 * その説明文字列を返す。該当しなければ null。
 *
 * @param {string} command
 * @returns {string | null}
 */
export function detectUnlabeledGhIssueCreate(command) {
  if (typeof command !== 'string' || command.trim() === '') return null

  const commandText = joinLineContinuations(stripHeredocBodies(command))

  for (const statement of splitStatements(commandText)) {
    const tokens = tokenize(statement)
    if (!isIssueCreate(tokens)) continue

    const labels = collectLabels(tokens.slice(3))
    const matched = labels.filter((label) => REQUIRED_LABELS.includes(label))

    if (matched.length === 0) {
      return 'ai-fixable / issue:needs-human-decision のどちらも付いていない'
    }
    if (matched.length > 1) {
      return `${REQUIRED_LABELS.join(' と ')} が両方付いている（この2つは排他）`
    }
  }

  return null
}
