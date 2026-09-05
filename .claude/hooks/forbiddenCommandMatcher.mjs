// 責務: bashコマンド文字列から「実行を禁止した危険コマンド」を検出する純粋関数のみを担う。
//
// 設計意図（WHY）:
// - bypass permissions mode で動く本ハーネスでは、Bash の実行を止められるのは hook だけである
//   （`permissions.deny` は設定されていない）。取り返しのつかない操作——公開範囲の変更・シークレットの
//   書き換え・本番反映・履歴やファイルの破壊——は、実行後に気づいても戻せないので実行前に止める。
// - 禁止コマンドの一覧は下の `RULE_GROUPS` が単一の情報源である。禁止を増やすときは hook を増やさず
//   この表に1行足す。hook は1本あたり node の起動コスト（実測で約44ms）が全 Bash 実行に乗るが、
//   表を伸ばしても判定コストはほぼ増えない（policy-driven-development-policy の
//   「ターン末ゲートは1本に統合する」と同じ理屈）。
// - 判定はコマンドの語頭に立つトークンだけを見る。引用符の中とヒアドキュメントの中身は実行されない
//   文字列なので、shellSplit.mjs の段階で判定対象から外れる（Issue #396）。
// - シェルの厳密なパースはしない。判定できない入力は通す（fail-open）。完全な安全機構ではなく、
//   AI が取り返しのつかない操作を「うっかり」実行するのを止めるガードレールである。
// - 外部状態は持たない。プロジェクトルート（削除先がプロジェクト外かの判定に要る）だけは
//   引数で受け取る。

import { detectEmptyGhBodyOverwrite } from './emptyGhBodyOverwriteMatcher.mjs'
import { detectGitBranchCreation } from './gitBranchCreationMatcher.mjs'
import { splitHeredoc, splitPipeStages, splitStatements } from './shellSplit.mjs'

// コマンド本体の前に置かれ、後続を実行するだけのトークン。剥がしてから語頭を判定する
const COMMAND_WRAPPERS = new Set(['sudo', 'env', 'npx', 'command', 'time', 'nohup'])
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

// サブコマンドの前に置ける git のグローバルオプション。うち値を伴うものは値ごと読み飛ばす。
// 剥がさないと `git -C /tmp push --force` のようにサブコマンドの位置がずれ、判定をすり抜ける
const GIT_GLOBAL_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace'])

// `gh api` で値を伴うフラグ。フラグの値を対象パスと読み違えないために使う
const GH_API_VALUE_FLAGS = new Set([
  '-X',
  '--method',
  '-f',
  '--raw-field',
  '-F',
  '--field',
  '-H',
  '--header',
  '-q',
  '--jq',
  '-t',
  '--template',
  '--hostname',
  '--cache',
  '--input'
])

// `gh api` で書き込むと復旧が難しい対象（ブランチ保護の解除・シークレット・変数）
const GH_API_DANGEROUS_PATHS = [
  /\/branches\/[^/]+\/protection/,
  /\/actions\/secrets/,
  /\/actions\/variables/
]

// `gh api` の暗黙 POST を書き込みとみなすためのフラグ。`-f` があると gh は自動で POST する
const GH_API_FIELD_FLAGS = new Set(['-f', '--raw-field', '-F', '--field', '--input'])
const GH_API_READ_METHODS = ['GET', 'HEAD']

// 権限確認を飛ばしてエージェント CLI を起動するフラグ（このガードレール自体を無効化する）
const AGENT_CLIS = new Set(['claude', 'codex', 'gemini', 'cursor-agent', 'aider', 'opencode'])
const AGENT_BYPASS_FLAGS = new Set([
  '--dangerously-skip-permissions',
  '--dangerously-bypass-approvals-and-sandbox',
  '--yolo',
  '--full-auto'
])

// 出力が空だと確定する引数。空文字列と、改行やエスケープを制御するだけの `echo` のフラグ（`-ne` も）
const EMPTY_OUTPUT_ARGUMENT = /^(?:""|''|-[ne]+)$/

// `>` によるリダイレクト。`1>` は無指定と同じ標準出力なので対象に含める。
// `>>`（追記）・`&>`・`2>` のような他の fd への出力は、ファイルを空にしないので対象外
const OUTPUT_REDIRECT = /(?:^|[^0-9>&])(1?)>(?!>)/

/**
 * 禁止コマンドの表。ここを読めば「何が禁止されているか」が分かる。
 *
 * 各ルールは次の条件を組み合わせて書き、すべて満たしたときに該当とする。
 * - `command`: 語頭のコマンド名が一致する
 * - `prefix`: 先頭から順にトークンが一致する
 * - `subcommandAnywhere`: 先頭以外のどこかに、このいずれかのトークンがある（グローバルフラグ対策）
 * - `anyFlag`: このいずれかのトークンがある
 * - `flagValue`: `[フラグ, 値]` が `--flag value` または `--flag=value` の形で並んでいる
 * - `detect`: 上の条件では書けないものだけ、`(tokens, context) => boolean` で判定する
 * - `detectWholeCommand`: 分割前のコマンド全体を見る判定（`(command) => string | null`）
 */
const RULE_GROUPS = [
  {
    category: '公開・流出',
    why: '一度外へ出た情報は取り消せない',
    rules: [
      {
        label: 'gh repo edit --visibility public',
        prefix: ['gh', 'repo', 'edit'],
        flagValue: ['--visibility', 'public']
      },
      { label: 'gh repo create --public', prefix: ['gh', 'repo', 'create'], anyFlag: ['--public'] },
      { label: 'gh gist create', prefix: ['gh', 'gist', 'create'] },
      { label: 'gh secret set', prefix: ['gh', 'secret', 'set'] },
      { label: 'gh secret delete', prefix: ['gh', 'secret', 'delete'] },
      { label: 'gh variable set', prefix: ['gh', 'variable', 'set'] },
      { label: 'gh variable delete', prefix: ['gh', 'variable', 'delete'] },
      { label: 'gh auth token', prefix: ['gh', 'auth', 'token'] },
      { label: 'gh auth login', prefix: ['gh', 'auth', 'login'] },
      { label: 'gh auth logout', prefix: ['gh', 'auth', 'logout'] },
      {
        label: 'gh api の破壊的な呼び出し',
        why: '削除・設定の変更・公開範囲の変更はどれも取り消せない',
        detect: isDangerousGhApiCall
      }
    ]
  },
  {
    category: '本番反映',
    why: '実環境が変わり、戻すにも実環境への操作が要る',
    rules: [
      { label: 'cdk deploy', command: 'cdk', subcommandAnywhere: ['deploy'] },
      { label: 'cdk destroy', command: 'cdk', subcommandAnywhere: ['destroy'] },
      { label: 'terraform apply', command: 'terraform', subcommandAnywhere: ['apply'] },
      { label: 'terraform destroy', command: 'terraform', subcommandAnywhere: ['destroy'] },
      { label: 'npm publish', prefix: ['npm', 'publish'] },
      { label: 'gh pr merge', prefix: ['gh', 'pr', 'merge'] },
      {
        label: 'gh pr review --approve',
        prefix: ['gh', 'pr', 'review'],
        anyFlag: ['--approve', '-a']
      },
      { label: 'gh workflow run', prefix: ['gh', 'workflow', 'run'] },
      { label: 'gh workflow disable', prefix: ['gh', 'workflow', 'disable'] },
      { label: 'gh run cancel', prefix: ['gh', 'run', 'cancel'] },
      { label: 'aws の delete-* / terminate-*', command: 'aws', detect: hasAwsDestructiveOperation }
    ]
  },
  {
    category: 'GitHub 上のデータ削除',
    why: 'GitHub の UI から元に戻せない',
    rules: [
      { label: 'gh repo delete', prefix: ['gh', 'repo', 'delete'] },
      { label: 'gh repo archive', prefix: ['gh', 'repo', 'archive'] },
      { label: 'gh release delete', prefix: ['gh', 'release', 'delete'] },
      { label: 'gh release delete-asset', prefix: ['gh', 'release', 'delete-asset'] },
      { label: 'gh issue delete', prefix: ['gh', 'issue', 'delete'] },
      { label: 'gh label delete', prefix: ['gh', 'label', 'delete'] },
      { label: 'gh cache delete', prefix: ['gh', 'cache', 'delete'] },
      {
        label: '既存の本文を空で上書きする gh 操作',
        detectWholeCommand: detectEmptyGhBodyOverwrite,
        advice: '本文を消すのが目的でなければ、本文を書いたファイルを --body-file <ファイル> で渡す'
      }
    ]
  },
  {
    category: 'git 履歴の破壊',
    why: '書き換えた履歴・捨てた変更は復元手段が残らない',
    rules: [
      {
        label: 'git push --force / --delete',
        prefix: ['git', 'push'],
        detect: hasDestructivePushArgument
      },
      { label: 'git reset --hard', prefix: ['git', 'reset'], anyFlag: ['--hard'] },
      { label: 'git clean -f / -x', prefix: ['git', 'clean'], detect: hasGitCleanDestructiveFlag },
      { label: 'git branch -D', prefix: ['git', 'branch'], anyFlag: ['-D'] },
      { label: 'git tag -d', prefix: ['git', 'tag'], anyFlag: ['-d', '--delete'] },
      { label: 'git stash drop', prefix: ['git', 'stash', 'drop'] },
      { label: 'git stash clear', prefix: ['git', 'stash', 'clear'] },
      { label: 'git filter-branch', prefix: ['git', 'filter-branch'] },
      { label: 'git filter-repo', prefix: ['git', 'filter-repo'] },
      { label: 'git reflog expire', prefix: ['git', 'reflog', 'expire'] },
      { label: 'git gc --prune=now', prefix: ['git', 'gc'], detect: hasImmediatePrune },
      { label: 'git rebase（git-policy で禁止）', prefix: ['git', 'rebase'] },
      {
        label: 'AI によるブランチの新規作成',
        why: 'ブランチ運用は人間が把握・判断する',
        detectWholeCommand: detectGitBranchCreation,
        advice: 'ブランチが必要な場合は人間に作成を依頼する'
      }
    ]
  },
  {
    category: 'ファイルの破壊',
    why: 'ファイルの削除・空化は元に戻せない',
    rules: [
      { label: 'rm による危険な場所の削除', command: 'rm', detect: hasDangerousRemoveTarget },
      { label: '空の内容によるファイルの上書き', detect: isEmptyContentOverwrite },
      { label: 'truncate によるファイルの空化', command: 'truncate', detect: hasZeroSizeOption },
      { label: 'find による一括削除', command: 'find', detect: hasFindDeleteAction }
    ]
  },
  {
    category: 'ゲートの迂回',
    why: 'このガードレール自体を無効化する',
    rules: [
      { label: '権限確認を飛ばすエージェント CLI の起動', detect: isAgentBypassInvocation },
      {
        label: 'git config によるコミット作者の改変',
        prefix: ['git', 'config'],
        detect: isCommitIdentityChange
      }
    ]
  }
]

const FORBIDDEN_COMMANDS = RULE_GROUPS.flatMap(({ category, why, rules }) =>
  // グループの why は既定値。ルール側に why があればそちらを使う
  rules.map((rule) => ({ category, why, ...rule }))
)

function tokenize(stage) {
  return stage.split(/\s+/).filter(Boolean)
}

function stripQuotes(value) {
  if (typeof value !== 'string') return value
  if (value.length >= 2 && value[0] === value.at(-1) && (value[0] === '"' || value[0] === "'")) {
    return value.slice(1, -1)
  }
  return value
}

/** 環境変数の代入とラッパーコマンドを剥がし、実際に実行されるコマンドを先頭に持ってくる。 */
function stripCommandPrefixes(tokens) {
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
  return stripGitGlobalOptions(tokens.slice(index))
}

/** `git` とサブコマンドの間に挟まったグローバルオプションを取り除く。 */
function stripGitGlobalOptions(tokens) {
  if (tokens[0] !== 'git') return tokens

  const rest = tokens.slice(1)
  let index = 0
  while (index < rest.length && rest[index].startsWith('-')) {
    if (GIT_GLOBAL_VALUE_FLAGS.has(rest[index])) index++
    index++
  }
  return ['git', ...rest.slice(index)]
}

function hasPrefix(tokens, prefix) {
  return prefix.every((expected, index) => tokens[index] === expected)
}

function findFlagValue(tokens, flag) {
  for (const [index, token] of tokens.entries()) {
    if (token === flag) return stripQuotes(tokens[index + 1])
    if (token.startsWith(`${flag}=`)) return stripQuotes(token.slice(flag.length + 1))
  }
  return undefined
}

/** 短縮フラグの束（`-rf` など）に含まれる文字を集める。長いフラグは対象外。 */
function shortFlagLetters(tokens) {
  return tokens
    .filter((token) => /^-[a-zA-Z]+$/.test(token))
    .flatMap((token) => [...token.slice(1)])
}

function nonFlagArguments(tokens) {
  return tokens
    .slice(1)
    .filter((token) => !token.startsWith('-'))
    .map(stripQuotes)
}

function hasDestructivePushArgument(tokens) {
  const DESTRUCTIVE_FLAGS = ['--force', '-f', '--delete', '-d']
  if (tokens.some((token) => DESTRUCTIVE_FLAGS.includes(token))) return true
  if (tokens.some((token) => token.startsWith('--force-with-lease'))) return true
  // `git push origin :feat/x` はリモートブランチの削除
  return tokens.slice(2).some((token) => stripQuotes(token).startsWith(':'))
}

function hasGitCleanDestructiveFlag(tokens) {
  if (tokens.includes('--force')) return true
  return shortFlagLetters(tokens).some((letter) => letter === 'f' || letter.toLowerCase() === 'x')
}

// 危険なのは猶予期間を無視する指定だけ。既定の猶予（`--prune=2.weeks.ago` など）は通常の運用値である
function hasImmediatePrune(tokens) {
  return tokens.includes('--prune=now') || tokens.includes('--prune=all')
}

function hasAwsDestructiveOperation(tokens) {
  return tokens.slice(1).some((token) => /^(?:delete|terminate)-[a-z0-9-]+$/.test(token))
}

function hasFindDeleteAction(tokens) {
  if (tokens.includes('-delete')) return true
  const execIndex = tokens.indexOf('-exec')
  return execIndex !== -1 && tokens.slice(execIndex + 1).includes('rm')
}

function hasZeroSizeOption(tokens) {
  const size = findFlagValue(tokens, '-s') ?? findFlagValue(tokens, '--size')
  if (size !== undefined) return Number(size) === 0
  return tokens.includes('-s0')
}

function isCommitIdentityChange(tokens) {
  const IDENTITY_KEYS = ['user.email', 'user.name']
  const keyIndex = tokens.findIndex((token) => IDENTITY_KEYS.includes(stripQuotes(token)))
  if (keyIndex === -1) return false
  if (tokens.includes('--unset')) return true
  // 値を伴わない `git config user.email` は読み取りなので通す
  return tokens[keyIndex + 1] !== undefined
}

function isEmptyOutputArgument(argument) {
  return EMPTY_OUTPUT_ARGUMENT.test(argument)
}

function isAgentBypassInvocation(tokens) {
  if (!AGENT_CLIS.has(tokens[0])) return false
  if (tokens.some((token) => AGENT_BYPASS_FLAGS.has(token))) return true
  return findFlagValue(tokens, '--permission-mode') === 'bypassPermissions'
}

function findGhApiEndpoint(tokens) {
  let index = 2
  while (index < tokens.length) {
    const token = tokens[index]
    if (!token.startsWith('-')) return stripQuotes(token)
    if (GH_API_VALUE_FLAGS.has(token)) index++
    index++
  }
  return undefined
}

function hasDangerousGraphqlMutation(stage) {
  if (/\bdeleteIssue\b/.test(stage) || /\bdeleteProject\b/.test(stage)) return true
  return /\bupdateRepository\b/.test(stage) && /visibility/.test(stage)
}

function isGhApiWrite(tokens, method) {
  if (method !== '' && !GH_API_READ_METHODS.includes(method)) return true
  // `-f` などのフィールド指定があると gh は明示のメソッド無しでも POST する
  return tokens.some((token) => GH_API_FIELD_FLAGS.has(token))
}

function isDangerousGhApiCall(tokens, { stage }) {
  if (tokens[0] !== 'gh' || tokens[1] !== 'api') return false

  const method = (
    findFlagValue(tokens, '-X') ??
    findFlagValue(tokens, '--method') ??
    ''
  ).toUpperCase()
  if (method === 'DELETE') return true

  const endpoint = findGhApiEndpoint(tokens) ?? ''
  if (endpoint === 'graphql') return hasDangerousGraphqlMutation(stage)
  if (!isGhApiWrite(tokens, method)) return false

  if (GH_API_DANGEROUS_PATHS.some((pattern) => pattern.test(endpoint))) return true
  // リポジトリ設定の visibility 変更（`-f visibility=public`）
  return tokens.some((token) => stripQuotes(token).startsWith('visibility='))
}

/**
 * 削除先が「消えても取り返しがつく場所」でないかを判定する。
 * プロジェクト内の相対パスだけを安全側とみなし、それ以外（ルート・ホーム・プロジェクト外・.git）は
 * 危険とみなす。ルートとホームそのものは再帰フラグの有無を問わず止める。
 */
function isDangerousRemoveTarget(target, { recursive, projectDir }) {
  const path = target.length > 1 ? target.replace(/\/+$/, '') : target
  const HOME_ALIASES = ['~', '$HOME', '${HOME}']
  // カレントディレクトリまるごとを指す相対パス。作業ディレクトリはたいていプロジェクトルートなので、
  // `rm -rf .` の被害は `rm -rf <プロジェクトルート>` と変わらない
  const WHOLE_DIRECTORY_TARGETS = ['.', './', '*', './*', '..']

  if (path === '/' || path === '/*') return true
  if (HOME_ALIASES.includes(path)) return true
  if (!recursive) return false

  if (WHOLE_DIRECTORY_TARGETS.includes(path)) return true
  if (path.split('/').includes('.git')) return true
  if (HOME_ALIASES.some((alias) => path.startsWith(`${alias}/`))) return true
  if (path.split('/').includes('..')) return true
  if (!path.startsWith('/')) return false
  return path === projectDir || !path.startsWith(`${projectDir}/`)
}

function hasDangerousRemoveTarget(tokens, { projectDir }) {
  const flags = tokens.filter((token) => token.startsWith('-'))
  const recursive =
    flags.includes('--recursive') ||
    shortFlagLetters(flags).some((letter) => letter.toLowerCase() === 'r')

  return nonFlagArguments(tokens).some((target) =>
    isDangerousRemoveTarget(target, { recursive, projectDir })
  )
}

/**
 * リダイレクト先を空にすると分かっているコマンドかを判定する。
 * 出力を持つコマンド（`gh issue list > x.txt`）とヒアドキュメント（`cat > x.md <<EOF`）は、
 * 書き込む中身があるので対象外。
 */
function isEmptyContentOverwrite(_tokens, { stage }) {
  const redirect = OUTPUT_REDIRECT.exec(stage)
  if (!redirect) return false

  // `>` と、それに前置された fd 番号（`1>`）を落とし、出力を作る側だけを取り出す
  const producerEnd = redirect.index + redirect[0].length - redirect[1].length - 1
  const producer = tokenize(stage.slice(0, producerEnd))

  if (producer.length === 0) return true
  if (producer.length === 1 && (producer[0] === ':' || producer[0] === 'true')) return true
  if (producer[0] === 'cat' && producer[1] === '/dev/null') return true
  if (producer[0] !== 'echo' && producer[0] !== 'printf') return false
  return producer.slice(1).every((argument) => isEmptyOutputArgument(argument))
}

function matchesRule(rule, tokens, context) {
  if (rule.command && tokens[0] !== rule.command) return false
  if (rule.prefix && !hasPrefix(tokens, rule.prefix)) return false
  if (rule.anyFlag && !tokens.some((token) => rule.anyFlag.includes(token))) return false
  if (rule.flagValue && findFlagValue(tokens, rule.flagValue[0]) !== rule.flagValue[1]) return false
  if (
    rule.subcommandAnywhere &&
    !tokens.slice(1).some((token) => rule.subcommandAnywhere.includes(token))
  ) {
    return false
  }
  if (rule.detect && !rule.detect(tokens, context)) return false
  return true
}

function describeViolation(rule, detail) {
  const advice = rule.advice ? `。${rule.advice}` : ''
  return `${rule.label}（${rule.category}: ${rule.why}）: ${detail}${advice}`
}

/**
 * bashコマンド文字列を検査し、禁止コマンドに該当すればその説明文字列を返す。該当しなければ null。
 *
 * @param {string} command bashコマンド文字列
 * @param {{ projectDir?: string }} [options] `projectDir` はプロジェクトルートの絶対パス
 *   （削除先がプロジェクト外かの判定に使う。既定は実行時の作業ディレクトリ）
 * @returns {string | null} 該当したルールの説明。該当しなければ null
 */
export function detectForbiddenCommand(command, { projectDir = process.cwd() } = {}) {
  if (typeof command !== 'string' || command.trim() === '') return null

  for (const rule of FORBIDDEN_COMMANDS) {
    const detail = rule.detectWholeCommand?.(command)
    if (detail) return describeViolation(rule, detail)
  }

  const { commandText } = splitHeredoc(command)
  const stages = splitStatements(commandText).flatMap(splitPipeStages)

  for (const stage of stages) {
    const tokens = stripCommandPrefixes(tokenize(stage))
    const context = { stage, projectDir }

    for (const rule of FORBIDDEN_COMMANDS) {
      if (rule.detectWholeCommand) continue
      if (matchesRule(rule, tokens, context)) return describeViolation(rule, stage)
    }
  }

  return null
}
