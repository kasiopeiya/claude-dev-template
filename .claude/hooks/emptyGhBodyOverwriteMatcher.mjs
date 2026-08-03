// 責務: bashコマンド文字列から「gh の編集系サブコマンドが既存の本文を空で上書きする呼び出し」を
// 検出する純粋関数のみを担う。
//
// 設計意図（WHY）:
// - GitHub は Issue / PR 本文の版を UI から戻せない。空で上書きすると、復元できるかどうかが
//   その場の記憶に懸かる。取り返しがつかない操作なので、実行前に止める。
// - 対象は既存の本文を「置き換える」コマンドだけ。create 系や `--edit-last` の無い comment は
//   新規作成であり、空でも失われるものが無いため対象外。
// - `--body-file -`（標準入力）は、同じコマンド文字列に書かれたヒアドキュメントの中身まで見て
//   空かどうかを判定する。中身のあるヒアドキュメント・パイプ・リダイレクトは通常の更新なので通す。
// - シェルの厳密なパース（クォート・サブシェル・変数展開）はしない。判定できない入力は通す
//   （fail-open）。ただし標準入力の供給元が1つも見当たらない `--body-file -` だけは、
//   空本文の書き込みが確定するので止める。

const HEREDOC_OPERATOR = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/

// 既存の本文を置き換えるコマンドと、そこで本文を空にできるフラグ（gh 2.87 時点）。
const OVERWRITE_TARGETS = [
  {
    subcommand: ['issue', 'edit'],
    label: 'gh issue edit',
    bodyFlags: ['-b', '--body'],
    bodyFileFlags: ['-F', '--body-file']
  },
  {
    subcommand: ['pr', 'edit'],
    label: 'gh pr edit',
    bodyFlags: ['-b', '--body'],
    bodyFileFlags: ['-F', '--body-file']
  },
  {
    subcommand: ['release', 'edit'],
    label: 'gh release edit',
    bodyFlags: ['-n', '--notes'],
    bodyFileFlags: ['-F', '--notes-file']
  },
  {
    subcommand: ['issue', 'comment'],
    label: 'gh issue comment --edit-last',
    requiredFlag: '--edit-last',
    bodyFlags: ['-b', '--body'],
    bodyFileFlags: ['-F', '--body-file']
  },
  {
    subcommand: ['pr', 'comment'],
    label: 'gh pr comment --edit-last',
    requiredFlag: '--edit-last',
    bodyFlags: ['-b', '--body'],
    bodyFileFlags: ['-F', '--body-file']
  }
]

/**
 * ヒアドキュメントの中身を、コマンド本体から切り離す。
 * 本文にはパイプや `;` を含む Markdown 表が入りうるため、先に分けないとコマンドの区切りを誤る。
 */
function splitHeredoc(command) {
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

function splitStatements(commandText) {
  return commandText
    .split(/&&|\|\||;|\n/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function tokenize(stage) {
  return stage.split(/\s+/).filter(Boolean)
}

function stripQuotes(value) {
  if (value.length >= 2 && value[0] === value.at(-1) && (value[0] === '"' || value[0] === "'")) {
    return value.slice(1, -1)
  }
  return value
}

// `<` は入力リダイレクト、`<<` はヒアドキュメント。後者は標準入力の供給元として別途判定する。
function hasInputRedirect(stage) {
  return /(^|[^<])<(?!<)/.test(stage)
}

function* iterateFlagValues(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (!token.startsWith('-')) continue

    const equalIndex = token.indexOf('=')
    if (equalIndex !== -1) {
      yield [token.slice(0, equalIndex), token.slice(equalIndex + 1)]
      continue
    }
    yield [token, tokens[i + 1]]
  }
}

function findTarget(tokens) {
  if (tokens[0] !== 'gh') return null
  return (
    OVERWRITE_TARGETS.find(
      ({ subcommand }) => subcommand[0] === tokens[1] && subcommand[1] === tokens[2]
    ) ?? null
  )
}

/**
 * `--body-file -` に渡る標準入力が空だと言い切れる場合だけ、その理由を返す。
 * 中身を静的に確かめられない供給元（パイプ・リダイレクト）は null を返して通す。
 */
function judgeEmptyStdin({ heredocBody, hasPipedStdin, hasRedirectedStdin }) {
  if (heredocBody !== null) {
    return heredocBody.trim() === '' ? 'ヒアドキュメントが空' : null
  }
  if (hasPipedStdin || hasRedirectedStdin) return null
  return '標準入力の供給元が無い'
}

function inspectTarget(target, tokens, stdin) {
  const flagTokens = tokens.slice(3)
  if (target.requiredFlag && !flagTokens.includes(target.requiredFlag)) return null

  for (const [flag, value] of iterateFlagValues(flagTokens)) {
    if (value === undefined) continue

    if (target.bodyFlags.includes(flag) && stripQuotes(value) === '') {
      return `${target.label} が ${flag} に空文字列を渡している`
    }
    if (target.bodyFileFlags.includes(flag) && stripQuotes(value) === '-') {
      const reason = judgeEmptyStdin(stdin)
      if (reason) return `${target.label} が ${flag} - に空の本文を渡している（${reason}）`
    }
  }
  return null
}

/**
 * bashコマンド文字列を検査し、既存の本文を空で上書きする gh 呼び出しがあれば
 * その説明文字列を返す。該当しなければ null。
 *
 * @param {string} command
 * @returns {string | null}
 */
export function detectEmptyGhBodyOverwrite(command) {
  if (typeof command !== 'string' || command.trim() === '') return null

  const { commandText, heredocBody } = splitHeredoc(command)

  for (const statement of splitStatements(commandText)) {
    const stages = statement.split('|')

    for (const [index, stage] of stages.entries()) {
      const tokens = tokenize(stage)
      const target = findTarget(tokens)
      if (!target) continue

      const violation = inspectTarget(target, tokens, {
        heredocBody,
        hasPipedStdin: index > 0,
        hasRedirectedStdin: hasInputRedirect(stage)
      })
      if (violation) return `${violation}: ${stage.trim()}`
    }
  }

  return null
}
