#!/usr/bin/env node
// 責務: 「issue N 対応して」と頼まれた Issue に、着手するか・先に監査するか・子を選ぶか・止まるかを決め、
//   1行目の先頭の語で返すことだけを担う。CLAUDE.md「issue番号だけで開発フローを自動追従する」が、
//   着手のコマンドを打った後、最初の Skill を起動する前に打たせる。
//
// 設計意図（WHY）:
// - 着手の条件を、CLAUDE.md の文章ではなくコードに置く。文章の条件は AI が毎回読み解くので読み違えうるうえ、
//   無人の経路（scripts/auto-programmer/index.mjs）のコードと2か所に持つと、片方の直し漏れで答えが食い違う（Issue #1543）。
//   判定は issueCheckVerdict.mjs・subIssueHandover.mjs の純粋関数を呼ぶだけにし、条件の置き場を1か所に保つ。
//   1行目の先頭の語（`進む：`・`監査する：`・`子を選ぶ：`・`止まる：`）はここだけが持ち、CLAUDE.md には写さない。
// - 対話でも、確認なしで /issue-check を打たせる（`監査する：`）。監査は行数の見積もりを通す関門で、
//   人間に打たせると手間が増える（Issue #1231）。
// - 読む先は、今いるリポジトリにする（`gh` に --repo を付けず、sub-issue の GraphQL は `{owner}`・`{repo}` の
//   展開で引く）。issueQuery.mjs の readIssueStatus・listSubIssues は config.mjs の repository を渡すが、
//   config.mjs はテンプレート同期の対象外で、利用先ではテンプレートを指したまま残りうる。別のリポジトリの Issue で
//   判定すると、止めるべき Issue を実装しうる。
// - 別のリポジトリにある子は選ばせない。子は番号だけで打ち直させるので、選ばせると、今のリポジトリの同じ番号の
//   別の Issue を読み、無関係な Issue を監査・実装しうる。
// - 判定できないとき（gh の失敗・読めない値・sub-issue の読み残し・不正な引数）は、止めて終了コード 1 で終える。
//   進む側に倒すと、止めるべき Issue を実装しうる。move-issue-card.mjs が 0 で終わるのは、カードが表示のためだけで、
//   着手を決めないから。
// - `--after-issue-check` は、監査を打った後だと呼ぶ側が渡す印にする。このコマンドは前回の結果を覚えないので、
//   旗が無いと、監査が判定を書き戻さないたびに `監査する：` が返り続ける。旗があれば監査を返さず、
//   判定が書き戻されたかを findSkipImplementationDecision が見て、書き戻されていなければ止める。
// - 対象ラベルは config.mjs の targetIssueLabel から読み、このファイルには持たない。
//
// 使い方: npm run --silent decide-issue-start -- <Issue番号> [--after-issue-check]
//   `--silent` が無いと、npm が先に `> root@1.0.0 …` の見出し行を出し、1行目が判定の語にならない

import {
  findSkipImplementationDecision,
  shouldRunIssueCheck
} from './auto-programmer/issueCheckVerdict.mjs'
import { runJson } from './auto-programmer/shell.mjs'
import { findReasonToSkipForOpenSubIssues } from './auto-programmer/subIssueHandover.mjs'
import { BusinessError, TechnicalError } from './lib/errors.mjs'

/**
 * @typedef {{ number: number, title: string, state: string, isInCurrentRepository: boolean }} SubIssue
 *   sub-issue（state は gh の表記で 'OPEN' / 'CLOSED'）
 * @typedef {{ headline: string, guidanceLines: string[] }} DecisionOutput
 *   1行目（先頭が判定の語）と、続けて出す案内の行
 */

const AFTER_ISSUE_CHECK_FLAG = '--after-issue-check'

const USAGE_MESSAGE = `Issue 番号を渡してください（例: npm run --silent decide-issue-start -- 123 [${AFTER_ISSUE_CHECK_FLAG}]）`

const DECIDE_ISSUE_START_COMMAND = 'npm run --silent decide-issue-start --'

// GraphQL が sub-issue を一度に返せる件数の上限。超えていたら、読み落とした子を選び損ねるので止める
const SUB_ISSUE_FETCH_LIMIT = 100

const SUB_ISSUES_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    issue(number: $number) {
      subIssues(first: ${SUB_ISSUE_FETCH_LIMIT}) {
        totalCount
        nodes { number title state repository { nameWithOwner } }
      }
    }
  }
}`

/**
 * 着手の判定を `止まる：` の出力に添える、監査を打っていないときの注記。
 * 理由の文は「/issue-check が…」で始まるが、監査を打っていなければ、ラベルは前回の監査か人間が付けたものである。
 */
const LABELS_NOT_FROM_THIS_RUN_NOTE =
  '今回は /issue-check を打っていません。理由は、前回の監査か人間が付けたラベルの状態です'

let decisionOutput
try {
  decisionOutput = await decideFromCommandLine()
} catch (error) {
  decisionOutput = buildUndecidableOutput(error)
  process.exitCode = 1
}
console.log([decisionOutput.headline, ...decisionOutput.guidanceLines].join('\n'))

/**
 * コマンドラインの引数から Issue を読み、着手の判定を決める。
 *
 * @returns {Promise<DecisionOutput>} 判定の出力
 * @throws {BusinessError} 引数が不正なとき
 * @throws {TechnicalError} gh が失敗したとき・設定や gh が返した値を読めないとき
 * @throws {Error} gh を起動できないとき・config.mjs を読み込めないとき
 */
async function decideFromCommandLine() {
  const { issueNumber, hasRunIssueCheck } = parseArguments(process.argv.slice(2))
  const targetIssueLabel = await readTargetIssueLabel()
  const issue = readIssueInCurrentRepository(issueNumber)
  return decideIssueStart(issue, { hasRunIssueCheck, targetIssueLabel })
}

/**
 * コマンドラインの引数から、Issue 番号と、監査を打った後かを読む。
 *
 * @param {string[]} commandLineArguments `node scripts/decide-issue-start.mjs` の後ろに渡された引数
 * @returns {{ issueNumber: number, hasRunIssueCheck: boolean }} Issue 番号と、`--after-issue-check` が付いていたか
 * @throws {BusinessError} Issue 番号が1つの正の整数として読めないとき
 */
function parseArguments(commandLineArguments) {
  const hasRunIssueCheck = commandLineArguments.includes(AFTER_ISSUE_CHECK_FLAG)
  const [rawIssueNumber, ...extraArguments] = commandLineArguments.filter(
    (argument) => argument !== AFTER_ISSUE_CHECK_FLAG
  )
  if (extraArguments.length > 0 || !/^[1-9]\d*$/.test(rawIssueNumber ?? '')) {
    throw new BusinessError(USAGE_MESSAGE)
  }
  return { issueNumber: Number(rawIssueNumber), hasRunIssueCheck }
}

/**
 * 実装へ進めてよい Issue に付く対象ラベルを config.mjs から読む。
 *
 * @returns {Promise<string>} 対象ラベル（config.mjs の targetIssueLabel）
 * @throws {TechnicalError} config.mjs の設定の検査に通らないとき・対象ラベルが無いとき
 * @throws {Error} config.mjs を読み込めないとき（ファイルが無い・構文の誤りなど）
 */
async function readTargetIssueLabel() {
  // config.mjs は読み込みの時点で設定を検査して throw する。静的 import だと判定の出力より前に落ち、
  // 判定を出さずにスタックトレースで終わるので、ここで読んで、失敗を「判定できません」として扱わせる
  const { config } = await import('./auto-programmer/config.mjs')
  if (typeof config.targetIssueLabel !== 'string' || config.targetIssueLabel === '') {
    throw new TechnicalError('config.mjs の targetIssueLabel を読めません')
  }
  return config.targetIssueLabel
}

/**
 * 今いるリポジトリの Issue の state・ラベル・sub-issue を読む。
 *
 * @param {number} issueNumber Issue の番号
 * @returns {{ issueNumber: number, state: string, labelNames: string[], subIssues: SubIssue[] }} Issue（state は 'OPEN' / 'CLOSED'。close 済みの Issue の sub-issue は読まず空にする）
 * @throws {TechnicalError} gh が失敗したとき（存在しない番号・未ログイン・git の外・ネットワーク断など）・gh が返した state・ラベルを読めないとき・sub-issue が一度に読める件数を超えたとき
 * @throws {Error} gh を起動できないとき（PATH に無いなど）
 */
function readIssueInCurrentRepository(issueNumber) {
  const { state, labels } = runJson('gh', [
    'issue',
    'view',
    String(issueNumber),
    '--json',
    'state,labels'
  ])
  // 読めない値を OPEN や空として進めると、止めるべき Issue を実装しうるので、読めないまま止める
  if ((state !== 'OPEN' && state !== 'CLOSED') || !Array.isArray(labels)) {
    throw new TechnicalError(
      `Issue #${issueNumber} の state かラベルを読めません: ${JSON.stringify({ state, labels })}`
    )
  }
  return {
    issueNumber,
    state,
    labelNames: labels.map(({ name }) => name),
    subIssues: state === 'OPEN' ? listSubIssuesInCurrentRepository(issueNumber) : []
  }
}

/**
 * 今いるリポジトリの Issue の sub-issue を引く。
 *
 * @param {number} issueNumber 親 Issue の番号
 * @returns {SubIssue[]} sub-issue（isInCurrentRepository は、子が親と同じリポジトリにあるか）
 * @throws {TechnicalError} gh が失敗したとき・sub-issue を読めないとき・sub-issue が一度に読める件数を超えたとき
 * @throws {Error} gh を起動できないとき（PATH に無いなど）
 */
function listSubIssuesInCurrentRepository(issueNumber) {
  const {
    data: { repository }
  } = runJson('gh', [
    'api',
    'graphql',
    '-f',
    `query=${SUB_ISSUES_QUERY}`,
    '-F',
    'owner={owner}',
    '-F',
    'name={repo}',
    '-F',
    `number=${issueNumber}`
  ])
  const subIssueConnection = repository?.issue?.subIssues
  if (
    !repository?.nameWithOwner ||
    !subIssueConnection ||
    !Array.isArray(subIssueConnection.nodes)
  ) {
    throw new TechnicalError(`#${issueNumber} の sub-issue を読めません`)
  }
  const { totalCount, nodes } = subIssueConnection
  if (totalCount > nodes.length) {
    throw new TechnicalError(
      `#${issueNumber} の sub-issue ${totalCount} 件のうち ${nodes.length} 件しか読めていません。読み落とした子を選び損ねるため止めます`
    )
  }
  return nodes.map(({ number, title, state, repository: subIssueRepository }) => ({
    number,
    title,
    state,
    isInCurrentRepository: subIssueRepository?.nameWithOwner === repository.nameWithOwner
  }))
}

/**
 * Issue の状態から、次にすることを決める。判定の順は上から当て、最初に当たったもので決める。
 *
 * @param {{ issueNumber: number, state: string, labelNames: string[], subIssues: SubIssue[] }} issue 読んだ Issue
 * @param {{ hasRunIssueCheck: boolean, targetIssueLabel: string }} context 監査を打った後か・対象ラベル
 * @returns {DecisionOutput} 判定の出力
 */
function decideIssueStart(
  { issueNumber, state, labelNames, subIssues },
  { hasRunIssueCheck, targetIssueLabel }
) {
  if (state !== 'OPEN') return buildStopOutput(`#${issueNumber} は close 済みです`)

  if (findReasonToSkipForOpenSubIssues(subIssues) !== null) {
    return buildChooseChildOutput(issueNumber, subIssues)
  }

  if (!hasRunIssueCheck && shouldRunIssueCheck(labelNames)) {
    return buildRunIssueCheckOutput(issueNumber)
  }

  const skipDecision = findSkipImplementationDecision({ state, labelNames }, targetIssueLabel)
  if (skipDecision !== null) return buildSkipOutput(skipDecision.reason, hasRunIssueCheck)

  return buildProceedOutput(issueNumber)
}

/**
 * 止まるときの出力を組む。1行目は「止まる：」と理由だけにする。
 *
 * @param {string} reason 止める理由
 * @returns {DecisionOutput} 判定の出力
 */
function buildStopOutput(reason) {
  return {
    headline: `止まる：${reason}`,
    guidanceLines: ['この Issue には着手せず、理由を人間に伝えて止まってください']
  }
}

/**
 * ラベルの状態から実装を止めるときの出力を組む。今回 /issue-check を打っていなければ、注記を足す。
 *
 * @param {string} reason findSkipImplementationDecision が返した、止める理由
 * @param {boolean} hasRunIssueCheck 今回 /issue-check を打った後か
 * @returns {DecisionOutput} 判定の出力
 */
function buildSkipOutput(reason, hasRunIssueCheck) {
  const stopOutput = buildStopOutput(reason)
  if (hasRunIssueCheck) return stopOutput
  return {
    ...stopOutput,
    guidanceLines: [LABELS_NOT_FROM_THIS_RUN_NOTE, ...stopOutput.guidanceLines]
  }
}

/**
 * 先に /issue-check を打たせるときの出力を組む。
 *
 * @param {number} issueNumber 監査する Issue の番号
 * @returns {DecisionOutput} 判定の出力
 */
function buildRunIssueCheckOutput(issueNumber) {
  return {
    headline: `監査する：#${issueNumber} は /issue-check を通していません。人間に確認せずに /issue-check #${issueNumber} を1回だけ打ってください`,
    guidanceLines: [
      `打ち終えたら、${DECIDE_ISSUE_START_COMMAND} ${issueNumber} ${AFTER_ISSUE_CHECK_FLAG} を打ち直し、その1行目の指示に従ってください`
    ]
  }
}

/**
 * 実装へ進ませるときの出力を組む。
 *
 * @param {number} issueNumber 着手する Issue の番号
 * @returns {DecisionOutput} 判定の出力
 */
function buildProceedOutput(issueNumber) {
  return {
    headline: `進む：#${issueNumber} は実装へ進めます`,
    guidanceLines: ['Issue の「実装フロー（使用するSkill）」の Skill を記載順に実行してください']
  }
}

/**
 * open な sub-issue を持つ親のときの出力を組む。どの子に着手するかは、段番号を見て AI が選ぶ。
 * 別のリポジトリにある子は、番号だけでは打ち直せないので並べない。選べる子が1件も無ければ止める。
 *
 * @param {number} parentIssueNumber 親 Issue の番号
 * @param {SubIssue[]} subIssues 親の sub-issue
 * @returns {DecisionOutput} 判定の出力（案内の行は、選べる子の番号・タイトル）
 */
function buildChooseChildOutput(parentIssueNumber, subIssues) {
  const openSubIssues = subIssues.filter(({ state }) => state === 'OPEN')
  const selectableSubIssues = openSubIssues.filter(
    ({ isInCurrentRepository }) => isInCurrentRepository
  )
  const otherRepositorySubIssueCount = openSubIssues.length - selectableSubIssues.length
  if (selectableSubIssues.length === 0) {
    return buildStopOutput(
      `#${parentIssueNumber} の open な sub-issue ${openSubIssues.length} 件はすべて別のリポジトリにあり、番号だけでは着手できません`
    )
  }
  const otherRepositoryNoteLines =
    otherRepositorySubIssueCount > 0
      ? [
          `別のリポジトリの open な sub-issue が ${otherRepositorySubIssueCount} 件あります。番号だけでは打てないので、選ばないでください`
        ]
      : []
  return {
    headline: `子を選ぶ：#${parentIssueNumber} は open な sub-issue を ${openSubIssues.length} 件持ちます。着手する子を下の一覧のタイトルの段番号から選び、子の番号で ${DECIDE_ISSUE_START_COMMAND} <子の番号> を打ち直してください`,
    guidanceLines: [
      ...selectableSubIssues.map(({ number, title }) => `#${number} ${title}`),
      ...otherRepositoryNoteLines
    ]
  }
}

/**
 * 判定できなかったときの出力を組む。
 *
 * @param {Error} error 判定できなかった原因（引数の誤り・gh の失敗・読めない値など）
 * @returns {DecisionOutput} 判定の出力（1行目は `止まる：判定できません（<理由>）`。原因のメッセージが複数行でも、空白でつないで1行にする）
 */
function buildUndecidableOutput(error) {
  const reason = error.message.replace(/\s*\n\s*/g, ' ').trim()
  return buildStopOutput(`判定できません（${reason}）`)
}
