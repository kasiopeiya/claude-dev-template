#!/usr/bin/env node
// 責務: open な週次 docs/・.claude/・CLAUDE.md の横断整合性チェック Issue が無いときだけ、その Issue を起票する。
//   起点は、実行結果コメントが付いた直近の週次 Issue の HEAD SHA から今回の HEAD までに
//   変わった、docs/ と .claude/ の Skill・agent・Rule とルートの CLAUDE.md の *.md に絞る（設計判断は
//   scripts/auto-programmer/README.md 「週次スクリプトが Issue を供給する」を参照）。
//   毎回読まれる文書（ALWAYS_LOADED_DOC_PATHS）が対象に含まれる週は、同じ Issue に減量チェック
//   （/slim-always-loaded-docs）も載せる。
//   ラベルの作成から起票まで自分で行い、呼び出し側の GitHub Actions
//   （.github/workflows/doc-consistency-weekly.yml）にはこのファイルを1回呼ぶことだけを残す
//   （判定に使うラベルと起票時に付けるラベルを分けて持つと、一致を呼び出し側の約束に頼ることになるため）。
//
// 使い方:
//   node scripts/ci/doc-audit-weekly-issue.mjs         起票したら、その URL を標準出力に返す。
//                                                     次のどちらかに当たるときは起票せず、その理由を標準出力に返す：
//                                                     open な週次 Issue がある／前回処理以降に走査範囲の変更が無い

import { execFileSync } from 'child_process'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

import {
  GITHUB_ISSUE_BODY_MAX_LENGTH,
  assertEmbeddablePaths,
  createIssue,
  ensureLabelExists,
  fetchIssueComments,
  hasOpenIssueWithLabel,
  listIssuesWithLabel
} from './weekly-issue-filing.mjs'
import { TechnicalError } from '../lib/errors.mjs'

// git はこのディレクトリを基準に実行する（カレントディレクトリに依存させない。
// 依存させると、リポジトリ直下以外から起動したとき走査範囲の変更が見つからず、黙って起票しない）
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const WEEKLY_ISSUE_LABEL = 'doc-audit-weekly'

// 週次チェックの走査範囲。差分の起点を集める `git diff` のパスと、起点が無いときに Issue 本文へ書く
// 「全体」の表示が、ともにこの一覧になる（別々に持つと、広げたときに片方だけ漏れる）。
// /doc-consistency が実際に走査する範囲は doc-consistency-reviewer-agent.md の「走査範囲」が別に持つので、
// 変えるときは両方を直す。.claude/ の hooks・settings.json は文書ではないので入れない
const CHECK_TARGET_PATHS = [
  'docs',
  '.claude/skills',
  '.claude/agents',
  '.claude/rules',
  '.claude/rule-bodies',
  'CLAUDE.md'
]

// ディレクトリには末尾の `/` を付けて表示する（ファイルの CLAUDE.md には付けない）
const CHECK_TARGET_PATHS_LABEL = CHECK_TARGET_PATHS.map((path) =>
  path.endsWith('.md') ? `\`${path}\`` : `\`${path}/\``
).join('・')

// 毎回読まれる文書。減量チェックの対象にする候補で、/slim-always-loaded-docs の「対象」節（引数が無いときの既定と、
// CLAUDE.md が `@` で import する project-claude.md）と同じ一覧。変えるときは両方を直す。
// すべて CHECK_TARGET_PATHS の下に置く（外にあると、変わっても差分に出ず、載せる週が来ない）。
// assertAlwaysLoadedDocsAreScanned が起動時に確かめる
const ALWAYS_LOADED_DOC_PATHS = [
  'CLAUDE.md',
  'docs/project-context/project-claude.md',
  'docs/policy-hub.md',
  'docs/design-hub.md'
]

const SLIM_COMMAND_NAME = '/slim-always-loaded-docs'

const AI_FIXABLE_LABEL = 'ai-fixable'

const WEEKLY_ISSUE_TITLE_WITHOUT_SLIM_CHECK =
  '週次: 文書横断の重複・矛盾チェック (/doc-consistency)'

// 題から、減量チェックが載る週だと分かるようにする
const WEEKLY_ISSUE_TITLE_WITH_SLIM_CHECK = `${WEEKLY_ISSUE_TITLE_WITHOUT_SLIM_CHECK} と毎回読まれる文書の減量チェック (${SLIM_COMMAND_NAME})`

/**
 * @typedef {object} SlimCheck 減量チェックを載せる週に、週次 Issue の各節へ足す文言。載せない週は、題以外すべて空文字にする
 *   （各節が「載せるか」で分岐せず、渡された文言をそのまま並べるだけにするため）。節ごとの文言を1か所に集め、
 *   減量チェックの仕様が変わったときに直す場所を `buildSlimCheck` だけにする
 * @property {string} title Issue の題
 * @property {string} reasonNote 「この変更が必要な理由」の末尾に足す文（先頭は改行）
 * @property {string} approachNote 「対応方針」の採る案に続けて書く文
 * @property {string} taskLine 「タスク一覧」に足す行（先頭は改行）
 * @property {string} resultNote 「タスク一覧」の実行結果コメントの括弧内に足す文
 * @property {string} completionLine 「完了条件」に足す行（先頭は改行）
 * @property {string} targetsLine 「現状」の対象箇所の次に足す行（先頭は改行）
 * @property {string} flowRow 「実装フロー」の表に足す行（先頭は改行）
 */

/** @type {SlimCheck} */
const NO_SLIM_CHECK = {
  title: WEEKLY_ISSUE_TITLE_WITHOUT_SLIM_CHECK,
  reasonNote: '',
  approachNote: '',
  taskLine: '',
  resultNote: '',
  completionLine: '',
  targetsLine: '',
  flowRow: ''
}

// タスク一覧・完了条件に書く見出しと、処理済みの週次 Issue を見分ける目印を1か所で持つ
// （ずれると処理済みの Issue が見つからず、毎回走査範囲の全体が起点に戻る）
const RESULT_COMMENT_HEADING = '## 実行結果'

// 公開リポジトリでは誰でもコメントできるため、権限を持つ人の実行結果コメントだけを「処理済み」の目印にする
const TRUSTED_AUTHOR_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])

// renderCurrentStateSection が書き出す HEAD SHA の行から、次回の起点として読み戻すための書式（1か所にまとめ、書き出す側と読み戻す側がずれないようにする）
const HEAD_SHA_LINE_PREFIX = '起票時点の既定ブランチの HEAD は'
const HEAD_SHA_LINE_PATTERN = new RegExp(`${HEAD_SHA_LINE_PREFIX} \`([0-9a-f]{7,40})\``)

// 処理済みの週次 Issue を探して遡る最大件数。週次頻度なら約2年分で、これを超えて未処理のまま
// 閉じた Issue が続くと走査範囲の全体へ静かにフォールバックする
const WEEKLY_ISSUE_LOOKUP_LIMIT = 100

function main() {
  assertAlwaysLoadedDocsAreScanned()
  if (hasOpenIssueWithLabel(WEEKLY_ISSUE_LABEL)) {
    console.log('起票しない（open な週次 Issue が既にある）')
    return
  }
  ensureLabelExists({
    name: WEEKLY_ISSUE_LABEL,
    description: '週次の docs/・.claude/・CLAUDE.md の横断整合性チェック Issue',
    color: '5319E7'
  })
  ensureLabelExists({
    name: AI_FIXABLE_LABEL,
    description: '問題と対応方針が一意に定まり、AIが単独で対応できるIssue',
    color: '0E8A16'
  })

  const headSha = getCurrentHeadSha()
  const scope = decideCheckScope(headSha)
  if (!scope) {
    console.log('起票しない（前回処理以降に走査範囲の変更が無い）')
    return
  }
  const { title, body } = buildWeeklyIssue(headSha, scope)
  const issueUrl = createIssue({
    title,
    labelNames: [AI_FIXABLE_LABEL, WEEKLY_ISSUE_LABEL],
    body
  })
  console.log(issueUrl)
}

/**
 * 毎回読まれる文書がすべて走査範囲（`CHECK_TARGET_PATHS`）の下にあることを確かめる。
 *
 * 外にあると、その文書が変わっても走査範囲の差分に出ず、減量チェックを載せる週が静かに来なくなる。
 *
 * @returns {void}
 * @throws {TechnicalError} 走査範囲の外にある文書が `ALWAYS_LOADED_DOC_PATHS` にあるとき
 */
function assertAlwaysLoadedDocsAreScanned() {
  const unscannedPaths = ALWAYS_LOADED_DOC_PATHS.filter(
    (path) => !CHECK_TARGET_PATHS.some((target) => path === target || path.startsWith(`${target}/`))
  )
  if (unscannedPaths.length > 0) {
    throw new TechnicalError(
      `毎回読まれる文書が走査範囲の外にある（減量チェックを載せる週が来なくなる）: ${unscannedPaths.join('・')}`
    )
  }
}

/**
 * リポジトリのローカル HEAD の SHA を返す。
 *
 * @returns {string} コミット SHA
 */
function getCurrentHeadSha() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
}

/**
 * 今回の週次チェックの対象範囲を決める。
 *
 * 処理済みの週次 Issue が無い・本文から SHA を読み取れない・SHA がこのリポジトリに無い
 * （履歴の書き換えなど）場合は走査範囲の全体を対象にする。前回処理以降に走査範囲の変更が無い
 * 場合は null を返し、起票しないと呼び出し側に判断させる。
 *
 * @param {string} headSha 今回のチェックの終点にする HEAD SHA
 * @returns {{ kind: 'all' } | { kind: 'changedFiles', files: string[] } | null} 対象範囲。files は必ず1件以上
 * @throws {BusinessError} 変わったファイルのパスに、Issue 本文へ埋め込めない文字（改行など）があるとき
 */
function decideCheckScope(headSha) {
  const lastProcessedSha = findLastProcessedWeeklyIssueSha()
  if (!lastProcessedSha || !isCommitAvailable(lastProcessedSha)) return { kind: 'all' }

  const files = computeChangedDocFilesBetween(lastProcessedSha, headSha)
  assertEmbeddablePaths(files)
  return files.length === 0 ? null : { kind: 'changedFiles', files }
}

/**
 * 直近で処理済み（信頼できる投稿者による `${RESULT_COMMENT_HEADING}` から始まるコメントが
 * 付いている）な週次 Issue の、起票時点の HEAD SHA を返す。
 *
 * 処理されずに閉じた週次 Issue（コメントが無いもの）は読み飛ばし、より古い Issue を見る。
 * 処理済みの週次 Issue が無い、または本文から SHA を読み取れない場合は null を返す。
 *
 * @returns {string | null} HEAD SHA。見つからなければ null
 */
function findLastProcessedWeeklyIssueSha() {
  const issues = listIssuesWithLabel({
    labelName: WEEKLY_ISSUE_LABEL,
    limit: WEEKLY_ISSUE_LOOKUP_LIMIT
  })
  issues.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

  for (const issue of issues) {
    if (!hasResultComment(issue.number)) continue
    const match = issue.body.match(HEAD_SHA_LINE_PATTERN)
    return match ? match[1] : null
  }
  return null
}

/**
 * 指定した週次 Issue に、信頼できる投稿者による `${RESULT_COMMENT_HEADING}` から始まる
 * コメントが付いているかを返す。
 *
 * @param {number} issueNumber Issue番号
 * @returns {boolean} 付いていれば true
 */
function hasResultComment(issueNumber) {
  return fetchIssueComments(issueNumber).some(
    (comment) =>
      TRUSTED_AUTHOR_ASSOCIATIONS.has(comment.authorAssociation) &&
      comment.body.trimStart().startsWith(RESULT_COMMENT_HEADING)
  )
}

/**
 * 指定した SHA がこのリポジトリのローカル履歴に存在するかを返す。
 *
 * @param {string} sha コミット SHA
 * @returns {boolean} 存在すれば true
 */
function isCommitAvailable(sha) {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: repoRoot, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * 指定した2つの SHA の間で変わった、走査範囲（`CHECK_TARGET_PATHS`）の `*.md` の一覧を返す。
 * 削除されたファイルは除き、リネームは新しいパスにする。
 *
 * @param {string} fromSha 起点にするコミット SHA
 * @param {string} toSha 終点にするコミット SHA
 * @returns {string[]} 変わった Markdown ファイルのパスの一覧
 */
function computeChangedDocFilesBetween(fromSha, toSha) {
  // -z（NUL区切り）でないと、日本語などASCII外のパスが core.quotePath でクォートされ、
  // 拡張子判定（.endsWith('.md')）に一致しなくなる
  const nameStatusOutput = execFileSync(
    'git',
    ['diff', '--name-status', '-z', '-M', fromSha, toSha, '--', ...CHECK_TARGET_PATHS],
    { cwd: repoRoot, encoding: 'utf8' }
  )
  const fields = nameStatusOutput.split('\0').filter((field) => field.length > 0)

  const changedFiles = []
  for (let fieldIndex = 0; fieldIndex < fields.length;) {
    const status = fields[fieldIndex]
    const isRenameOrCopy = status.startsWith('R') || status.startsWith('C')
    const pathFieldCount = isRenameOrCopy ? 2 : 1
    const path = fields[fieldIndex + pathFieldCount]
    fieldIndex += 1 + pathFieldCount

    if (status.startsWith('D')) continue
    if (path.endsWith('.md')) changedFiles.push(path)
  }
  return changedFiles
}

/**
 * 今回の週次 Issue の題と本文を組み立てる。本文の長さが GitHub の Issue 本文の上限を超える場合は、
 * 対象範囲を走査範囲の全体に落として作り直す（題も、落とした後の対象範囲で決め直す）。
 *
 * @param {string} headSha 起票時点の HEAD の SHA
 * @param {{ kind: 'all' } | { kind: 'changedFiles', files: string[] }} scope 対象範囲
 * @returns {{ title: string, body: string }} Issue の題と本文
 */
function buildWeeklyIssue(headSha, scope) {
  const weeklyIssue = renderWeeklyIssue(headSha, scope)
  if (weeklyIssue.body.length <= GITHUB_ISSUE_BODY_MAX_LENGTH) return weeklyIssue
  return renderWeeklyIssue(headSha, { kind: 'all' })
}

/**
 * 減量チェックの対象にする、毎回読まれる文書を決める。
 *
 * 走査範囲の全体を対象にする週は（理由を問わず）`ALWAYS_LOADED_DOC_PATHS` のすべて、
 * 差分を対象にする週は変わったものだけにする。
 *
 * @param {{ kind: 'all' } | { kind: 'changedFiles', files: string[] }} scope 対象範囲
 * @returns {string[]} 対象のパス。減量チェックを載せない週は空配列
 */
function decideSlimTargets(scope) {
  if (scope.kind === 'all') return ALWAYS_LOADED_DOC_PATHS
  return ALWAYS_LOADED_DOC_PATHS.filter((path) => scope.files.includes(path))
}

/**
 * パスを、入れ子の箇条書き（2文字下げ）に整形する。
 *
 * @param {string[]} paths パスの一覧
 * @returns {string} 箇条書き
 */
function formatPathBulletList(paths) {
  return paths.map((path) => `  - \`${path}\``).join('\n')
}

/**
 * 減量チェックを載せる週に、各節へ足す文言を作る。
 *
 * @param {string[]} slimTargets 減量チェックの対象のパス。空配列なら載せない週
 * @returns {SlimCheck} 各節へ足す文言。載せない週は `NO_SLIM_CHECK`
 */
function buildSlimCheck(slimTargets) {
  if (slimTargets.length === 0) return NO_SLIM_CHECK
  const command = `${SLIM_COMMAND_NAME} ${slimTargets.join(' ')}`
  const targetPathsLabel = slimTargets.map((path) => `\`${path}\``).join('・')
  return {
    title: WEEKLY_ISSUE_TITLE_WITH_SLIM_CHECK,
    reasonNote: `
あわせて、毎回全文が読まれる文書のうち ${targetPathsLabel} が今回の対象に含まれるため、その減量チェックも載せている。
これらは文字数がそのまま毎回のコンテキスト消費になり、上限内なら足されるばかりで、後から削る仕組みが他に無い。`,
    approachNote: `続けて \`${command}\` を実行し、毎回読まれる文書の減量候補を Issue に起票する（文書そのものは直さない）。`,
    taskLine: `\n- [ ] \`${command}\` を実行する`,
    resultNote: '。減量チェックの結果も同じコメントに、チェックごとに分けて書く',
    completionLine: `\n- [ ] \`${SLIM_COMMAND_NAME}\` の結果（起票した Issue の番号、または「該当なし」）が、そのコメントに書かれている`,
    targetsLine: `\n- **減量チェックの対象**：\n${formatPathBulletList(slimTargets)}`,
    flowRow: `\n| 2   | 減量チェックの実行 | \`${command}\` |`
  }
}

/**
 * 週次 Issue の題と本文を描画する。
 *
 * @param {string} headSha 起票時点の HEAD の SHA
 * @param {{ kind: 'all' } | { kind: 'changedFiles', files: string[] }} scope 対象範囲
 * @returns {{ title: string, body: string }} Issue の題と本文
 */
function renderWeeklyIssue(headSha, scope) {
  const slimCheck = buildSlimCheck(decideSlimTargets(scope))
  const docConsistencyCommand =
    scope.kind === 'all' ? '/doc-consistency' : `/doc-consistency ${scope.files.join(' ')}`

  return {
    title: slimCheck.title,
    body: [
      renderReasonSection(slimCheck),
      renderApproachSection({ docConsistencyCommand, slimCheck }),
      renderTaskSection({ docConsistencyCommand, slimCheck }),
      renderCompletionSection(slimCheck),
      renderCurrentStateSection({ headSha, scope, slimCheck }),
      renderImplementationFlowSection({ docConsistencyCommand, slimCheck }),
      renderBlockerSection()
    ].join('\n\n')
  }
}

/**
 * @param {SlimCheck} slimCheck 減量チェックの文言
 * @returns {string} 「この変更が必要な理由」の節
 */
function renderReasonSection(slimCheck) {
  return `## この変更が必要な理由

docs/ 配下の文書と、.claude/ の Skill・agent・Rule と、ルートの CLAUDE.md は、差分レビューでは変更行しか見ないため、文書をまたぐ重複・矛盾を拾えない。
このIssueは、週1回そのギャップを埋めるために自動起票された定期チェックである。
放置すると、劣化した文書を手本に AI が横展開し、重複・矛盾が加速度的に増える。${slimCheck.reasonNote}`
}

/**
 * @param {{ docConsistencyCommand: string, slimCheck: SlimCheck }} sectionInputs
 *   docConsistencyCommand: 実行する `/doc-consistency` / slimCheck: 減量チェックの文言
 * @returns {string} 「対応方針」の節
 */
function renderApproachSection({ docConsistencyCommand, slimCheck }) {
  return `## 対応方針

**採る案**：\`${docConsistencyCommand}\` を実行し、下記の対象箇所を横断チェックする。${slimCheck.approachNote}

**根拠**：このIssueは定期チェックとして自動起票されたものであり、対応方針は起票時点で固定されている。

**却下した案**：なし（自動起票のため、この Issue 自体に案の比較は無い）。`
}

/**
 * @param {{ docConsistencyCommand: string, slimCheck: SlimCheck }} sectionInputs
 *   docConsistencyCommand: 実行する `/doc-consistency` / slimCheck: 減量チェックの文言
 * @returns {string} 「タスク一覧」の節
 */
function renderTaskSection({ docConsistencyCommand, slimCheck }) {
  return `## タスク一覧

- [ ] \`${docConsistencyCommand}\` を実行する${slimCheck.taskLine}
- [ ] 実行結果を \`${RESULT_COMMENT_HEADING}\` から始まるコメントとして残す（起票した Issue の番号。0件なら「0件」と書く${slimCheck.resultNote}）`
}

/**
 * @param {SlimCheck} slimCheck 減量チェックの文言
 * @returns {string} 「完了条件」の節
 */
function renderCompletionSection(slimCheck) {
  return `## 完了条件

- [ ] \`${RESULT_COMMENT_HEADING}\` から始まるコメントが残っている${slimCheck.completionLine}`
}

/**
 * @param {{ headSha: string, scope: { kind: 'all' } | { kind: 'changedFiles', files: string[] }, slimCheck: SlimCheck }} sectionInputs
 *   headSha: 起票時点の HEAD の SHA / scope: 対象範囲 / slimCheck: 減量チェックの文言
 * @returns {string} 「現状」の節
 */
function renderCurrentStateSection({ headSha, scope, slimCheck }) {
  const targetDocsSection =
    scope.kind === 'all' ? `${CHECK_TARGET_PATHS_LABEL} の全体` : formatPathBulletList(scope.files)
  return `## 現状

- **対象箇所**：
${targetDocsSection}${slimCheck.targetsLine}
- **確認済み**：${HEAD_SHA_LINE_PREFIX} \`${headSha}\`
- **未確認**：なし
- **却下した案**：なし`
}

/**
 * @param {{ docConsistencyCommand: string, slimCheck: SlimCheck }} sectionInputs
 *   docConsistencyCommand: 実行する `/doc-consistency` / slimCheck: 減量チェックの文言
 * @returns {string} 「実装フロー（使用するSkill）」の節
 */
function renderImplementationFlowSection({ docConsistencyCommand, slimCheck }) {
  return `## 実装フロー（使用するSkill）

| 順  | 変更種別         | 使用Skill             |
| --- | ---------------- | ---------------------- |
| 1   | 定期チェックの実行 | \`${docConsistencyCommand}\` |${slimCheck.flowRow}`
}

/**
 * @returns {string} 「ブロッカー」の節（末尾の改行を含む）
 */
function renderBlockerSection() {
  return `## ブロッカー

なし（すぐ着手できる）
`
}

try {
  main()
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
