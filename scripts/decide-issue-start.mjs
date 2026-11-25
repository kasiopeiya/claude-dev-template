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
//   進む側に倒すと、止めるべき Issue を実装しうる。move-issue-card.mjs が 0 で終わるのは、カードも担当者も記録のためだけで、
//   着手を決めないから。
// - `--after-issue-check` は、監査を打った後だと呼ぶ側が渡す印にする。このコマンドは前回の結果を覚えないので、
//   旗が無いと、監査が判定を書き戻さないたびに `監査する：` が返り続ける。旗があれば監査を返さず、
//   判定が書き戻されたかを findSkipImplementationDecision が見て、書き戻されていなければ止める。
// - `--skip-issue-check` は、人間が監査を飛ばす Skill（急ぐ `/asap` と、監査だけを飛ばす `/no-issue-check`）だけが渡す。
//   #1231 の「『issue N 対応して』では issue-check を自動で通す」を、人間しか打てない Skill に限って外す。読み替えを SKILL.md に書くと、人間判断待ちの
//   Issue をラベルを見ずに実装しうるので、旗として本スクリプトに置く。旗があれば、監査の指示と「監査が判定を書き戻さなかった」
//   で止める判定だけを外す。close 済み・子を持つ親・未完のブロッカー・人間向けのラベル・対象ラベルが無い、の判定は旗の有無で変えない。
//   子を選ばせるときは、打ち直しにも旗を付けさせる。旗なしで打ち直すと、子の判定で `監査する：` が返るため。
//   `進む：` は旗の有無で1行目を変えず、`/asap` 向けの案内を2行目に足す。どの Skill から打たれたかはこのコマンドに
//   分からないので、2行目を「`/asap` から打ったときは」と名指しして、`/asap` だけが自分の手順へ分かれる（Issue #1990）。
// - ブロッカーは本文の `## ブロッカー` 節から読み、すべて closed と確かめられなければ止める。無人の経路（board.mjs）と
//   同じ扱いにし、同じ Issue への答えを両経路で揃える。節の読み方は startOrder.mjs の extractBlockerIssueNumbers を流用し、
//   2か所に持たない。節が読めない・ブロッカーの state を引けないときも止める側に倒す。未完の依存先を待たずに実装すると、
//   依存先がまだ決めていない用語や名前を書きうる（Issue #1952）。
// - `needs-human-decision` で止めるときだけ、案内の行に「実装フローの先頭が `/grill-me` なら止まらず起動してよい」例外を
//   載せる。対話の経路は人間がその場にいて、`/grill-me` は人間と対話して方針を詰める Skill なので、人間判断の印と食い違わない。
//   1行目は `止まる：` のまま変えず、`/asap` の「止まる指示なら終了」も変えない。`--skip-issue-check`（`/asap`・`/no-issue-check`）では例外を出さない。
//   例外を CLAUDE.md に書くと毎回読む文書が増え、`進む：` を返すと Issue 本文の表を機械で読む結合が増える（Issue #1940）。
// - 対象ラベルは config.mjs の targetIssueLabel から読み、このファイルには持たない。
// - `進む：` の1行目に、実装フローの表の「順」の読み方（同じ順の Skill は並行して起動してよい）を載せる。
//   CLAUDE.md は「記載順に実行する」と書くだけで、従わせるのはこの1行目だけである。CLAUDE.md を変えずに、
//   ここで「順」の意味を宣言する。
//
// 使い方: npm run --silent decide-issue-start -- <Issue番号> [--after-issue-check | --skip-issue-check]
//   `--silent` が無いと、npm が先に `> root@1.0.0 …` の見出し行を出し、1行目が判定の語にならない

import {
  findSkipImplementationDecision,
  NEEDS_HUMAN_DECISION_LABEL,
  shouldRunIssueCheck
} from './auto-programmer/issueCheckVerdict.mjs'
import { runJson } from './auto-programmer/shell.mjs'
import { extractBlockerIssueNumbers } from './auto-programmer/startOrder.mjs'
import { findReasonToSkipForOpenSubIssues } from './auto-programmer/subIssueHandover.mjs'
import { BusinessError, TechnicalError } from './lib/errors.mjs'

/**
 * @typedef {{ number: number, title: string, state: string, isInCurrentRepository: boolean }} SubIssue
 *   sub-issue（state は gh の表記で 'OPEN' / 'CLOSED'）
 * @typedef {{ headline: string, guidanceLines: string[] }} DecisionOutput
 *   1行目（先頭が判定の語）と、続けて出す案内の行
 * @typedef {{ issueNumber: number, state: string, labelNames: string[], subIssues: SubIssue[], blockerNumbers: number[] | null, unresolvedBlockerNumbers: number[] }} IssueForDecision
 *   読んだ Issue（state は 'OPEN' / 'CLOSED'。blockerNumbers はブロッカー節の番号で、節の書式が読めなければ null。
 *   unresolvedBlockerNumbers はそのうち closed と確かめられなかった番号。close 済みの Issue では、子もブロッカーも読まず空にする）
 */

const AFTER_ISSUE_CHECK_FLAG = '--after-issue-check'
const SKIP_ISSUE_CHECK_FLAG = '--skip-issue-check'

const USAGE_MESSAGE = `Issue 番号を渡してください（例: npm run --silent decide-issue-start -- 123 [${AFTER_ISSUE_CHECK_FLAG} | ${SKIP_ISSUE_CHECK_FLAG}]）`

const DECIDE_ISSUE_START_COMMAND = 'npm run --silent decide-issue-start --'

// 実装フローの表の「順」の読み方。`進む：` の1行目に載せる
const PARALLEL_FLOW_INSTRUCTION =
  'Issue の「実装フロー（使用するSkill）」は順の小さい行から実行し、同じ順の Skill は互いに独立なので、結果を待たずに続けて起動してよい'

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

// needs-human-decision で止めるとき、止める案内の行と差し替える
const GRILL_ME_EXCEPTION_GUIDANCE =
  '人間がこの対話で着手を頼んだ・選んだ Issue で、実装フロー（使用するSkill）の先頭が `/grill-me` なら、止まらず `/grill-me` を起動してください。それ以外は、この Issue には着手せず、理由を人間に伝えて止まってください'

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
  const { issueNumber, hasRunIssueCheck, isIssueCheckSkipped } = parseArguments(
    process.argv.slice(2)
  )
  const targetIssueLabel = await readTargetIssueLabel()
  const issue = readIssueInCurrentRepository(issueNumber)
  return decideIssueStart(issue, { hasRunIssueCheck, isIssueCheckSkipped, targetIssueLabel })
}

/**
 * コマンドラインの引数から、Issue 番号と、監査を打った後か・監査を飛ばすかを読む。
 *
 * @param {string[]} commandLineArguments `node scripts/decide-issue-start.mjs` の後ろに渡された引数
 * @returns {{ issueNumber: number, hasRunIssueCheck: boolean, isIssueCheckSkipped: boolean }} Issue 番号と、`--after-issue-check` が付いていたか、`--skip-issue-check` が付いていたか
 * @throws {BusinessError} Issue 番号が1つの正の整数として読めないとき
 */
function parseArguments(commandLineArguments) {
  const hasRunIssueCheck = commandLineArguments.includes(AFTER_ISSUE_CHECK_FLAG)
  const isIssueCheckSkipped = commandLineArguments.includes(SKIP_ISSUE_CHECK_FLAG)
  const [rawIssueNumber, ...extraArguments] = commandLineArguments.filter(
    (argument) => argument !== AFTER_ISSUE_CHECK_FLAG && argument !== SKIP_ISSUE_CHECK_FLAG
  )
  if (extraArguments.length > 0 || !/^[1-9]\d*$/.test(rawIssueNumber ?? '')) {
    throw new BusinessError(USAGE_MESSAGE)
  }
  return { issueNumber: Number(rawIssueNumber), hasRunIssueCheck, isIssueCheckSkipped }
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
 * 今いるリポジトリの Issue の state・ラベル・sub-issue・ブロッカーを読む。
 *
 * @param {number} issueNumber Issue の番号
 * @returns {IssueForDecision} Issue
 * @throws {TechnicalError} gh が失敗したとき（存在しない番号・未ログイン・git の外・ネットワーク断など）・gh が返した state・ラベル・本文を読めないとき・sub-issue が一度に読める件数を超えたとき
 * @throws {Error} gh を起動できないとき（PATH に無いなど）
 */
function readIssueInCurrentRepository(issueNumber) {
  const { state, labels, body } = runJson('gh', [
    'issue',
    'view',
    String(issueNumber),
    '--json',
    'state,labels,body'
  ])
  // 読めない値を OPEN や空として進めると、止めるべき Issue を実装しうるので、読めないまま止める
  if (
    (state !== 'OPEN' && state !== 'CLOSED') ||
    !Array.isArray(labels) ||
    typeof body !== 'string'
  ) {
    throw new TechnicalError(
      `Issue #${issueNumber} の state・ラベル・本文を読めません: ${JSON.stringify({ state, labels, hasBody: typeof body === 'string' })}`
    )
  }
  const labelNames = labels.map(({ name }) => name)
  if (state !== 'OPEN') {
    return {
      issueNumber,
      state,
      labelNames,
      subIssues: [],
      blockerNumbers: [],
      unresolvedBlockerNumbers: []
    }
  }
  const blockerNumbers = extractBlockerIssueNumbers(body)
  return {
    issueNumber,
    state,
    labelNames,
    subIssues: listSubIssuesInCurrentRepository(issueNumber),
    blockerNumbers,
    unresolvedBlockerNumbers: [...new Set(blockerNumbers ?? [])].filter(
      (blockerNumber) => readIssueStateInCurrentRepository(blockerNumber) !== 'CLOSED'
    )
  }
}

/**
 * 今いるリポジトリの Issue の state を引く。ブロッカーが closed かを確かめるのに使う。
 *
 * @param {number} issueNumber Issue の番号
 * @returns {unknown} gh が返した state（'OPEN' / 'CLOSED' のはずだが検査しない。呼ぶ側は 'CLOSED' 以外をすべて未完とみなす）
 * @throws {TechnicalError} gh が失敗したとき（存在しない番号・未ログイン・ネットワーク断など）
 * @throws {Error} gh を起動できないとき（PATH に無いなど）
 */
function readIssueStateInCurrentRepository(issueNumber) {
  try {
    return runJson('gh', ['issue', 'view', String(issueNumber), '--json', 'state']).state
  } catch (error) {
    if (!(error instanceof TechnicalError)) throw error
    throw new TechnicalError(`ブロッカー #${issueNumber} の state を引けません: ${error.message}`)
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
 * @param {IssueForDecision} issue 読んだ Issue
 * @param {{ hasRunIssueCheck: boolean, isIssueCheckSkipped: boolean, targetIssueLabel: string }} context 監査を打った後か・監査を飛ばすか・対象ラベル
 * @returns {DecisionOutput} 判定の出力
 */
function decideIssueStart(
  { issueNumber, state, labelNames, subIssues, blockerNumbers, unresolvedBlockerNumbers },
  { hasRunIssueCheck, isIssueCheckSkipped, targetIssueLabel }
) {
  if (state !== 'OPEN') return buildStopOutput(`#${issueNumber} は close 済みです`)

  if (findReasonToSkipForOpenSubIssues(subIssues) !== null) {
    return buildChooseChildOutput(issueNumber, subIssues, isIssueCheckSkipped)
  }

  if (blockerNumbers === null) {
    return buildStopOutput(
      `#${issueNumber} の「## ブロッカー」節に、番号を読めない箇条書きの行があります`
    )
  }
  if (unresolvedBlockerNumbers.length > 0) {
    const blockerList = unresolvedBlockerNumbers.map((number) => `#${number}`).join('・')
    return buildStopOutput(`#${issueNumber} は ${blockerList} の完了待ちです`)
  }

  if (!hasRunIssueCheck && !isIssueCheckSkipped && shouldRunIssueCheck(labelNames)) {
    return buildRunIssueCheckOutput(issueNumber)
  }

  const skipDecision = findSkipImplementationDecision({ state, labelNames }, targetIssueLabel, {
    isWritebackCheckSkipped: isIssueCheckSkipped
  })
  if (skipDecision !== null) {
    return buildSkipOutput(skipDecision, { hasRunIssueCheck, isIssueCheckSkipped })
  }

  return buildProceedOutput(issueNumber, isIssueCheckSkipped)
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
 * `needs-human-decision` で止めるときは、`--skip-issue-check` が無ければ案内の行を `/grill-me` の例外つきに差し替える。
 *
 * @param {{ reason: string, humanOnlyLabel: string | null }} skipDecision findSkipImplementationDecision が返した、止める理由と人間向けのラベル
 * @param {{ hasRunIssueCheck: boolean, isIssueCheckSkipped: boolean }} context 今回 /issue-check を打った後か・監査を飛ばすか
 * @returns {DecisionOutput} 判定の出力
 */
function buildSkipOutput({ reason, humanOnlyLabel }, { hasRunIssueCheck, isIssueCheckSkipped }) {
  const baseOutput = buildStopOutput(reason)
  const stopOutput =
    humanOnlyLabel === NEEDS_HUMAN_DECISION_LABEL && !isIssueCheckSkipped
      ? { ...baseOutput, guidanceLines: [GRILL_ME_EXCEPTION_GUIDANCE] }
      : baseOutput
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
 * @param {boolean} isIssueCheckSkipped 監査を飛ばして進むか（`--skip-issue-check`）。true なら、`/asap` から打ったときの案内の行を足す
 * @returns {DecisionOutput} 判定の出力
 */
function buildProceedOutput(issueNumber, isIssueCheckSkipped) {
  return {
    headline: `進む：#${issueNumber} は実装へ進めます。${PARALLEL_FLOW_INSTRUCTION}`,
    guidanceLines: isIssueCheckSkipped
      ? [
          '/asap から打ったときは /asap の手順で進めてください（Issue の「実装フロー（使用するSkill）」の Skill は呼びません）'
        ]
      : []
  }
}

/**
 * open な sub-issue を持つ親のときの出力を組む。どの子に着手するかは、段番号を見て AI が選ぶ。
 * 別のリポジトリにある子は、番号だけでは打ち直せないので並べない。選べる子が1件も無ければ止める。
 *
 * @param {number} parentIssueNumber 親 Issue の番号
 * @param {SubIssue[]} subIssues 親の sub-issue
 * @param {boolean} isIssueCheckSkipped 監査を飛ばして進むか（`--skip-issue-check`）。true なら子の番号での打ち直しにも旗を付けさせる
 * @returns {DecisionOutput} 判定の出力（案内の行は、選べる子の番号・タイトル）
 */
function buildChooseChildOutput(parentIssueNumber, subIssues, isIssueCheckSkipped) {
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
  const rerunCommand = `${DECIDE_ISSUE_START_COMMAND} <子の番号>${isIssueCheckSkipped ? ` ${SKIP_ISSUE_CHECK_FLAG}` : ''}`
  return {
    headline: `子を選ぶ：#${parentIssueNumber} は open な sub-issue を ${openSubIssues.length} 件持ちます。着手する子を下の一覧のタイトルの段番号から選び、子の番号で ${rerunCommand} を打ち直してください`,
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
