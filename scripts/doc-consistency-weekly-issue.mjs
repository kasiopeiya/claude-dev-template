#!/usr/bin/env node
// 責務: open な週次 docs/ 横断整合性チェック Issue が無いときだけ、その Issue を起票する
//   （docs/adr/006-skip-weekly-issue-when-open.md）。起点は、実行結果コメントが付いた
//   直近の週次 Issue の HEAD SHA から今回の HEAD までに変わった docs/**/*.md に絞る
//   （docs/adr/008-weekly-issue-scope-since-last-processed.md）。
//   ラベルの作成から起票まで自分で行い、呼び出し側の GitHub Actions
//   （.github/workflows/doc-consistency-weekly.yml）にはこのファイルを1回呼ぶことだけを残す
//   （判定に使うラベルと起票時に付けるラベルを分けて持つと、一致を呼び出し側の約束に頼ることになるため）。
//
// 使い方:
//   node scripts/doc-consistency-weekly-issue.mjs   起票したら、その URL を標準出力に返す。
//                                                     次のどちらかに当たるときは起票せず、その理由を標準出力に返す：
//                                                     open な週次 Issue がある／前回処理以降に docs/ の変更が無い

import { execFileSync } from 'child_process'
import { resolve } from 'path'
import { fileURLToPath } from 'url'

// 週次 Issue を見分ける専用ラベル
const WEEKLY_LABEL = 'doc-consistency-weekly'

const WEEKLY_ISSUE_TITLE = '週次: docs/ 横断の重複・矛盾チェック (/doc-consistency)'

// タスク一覧・完了条件に書く見出しと、処理済みの週次 Issue を見分ける目印を1か所で持つ
// （ずれると処理済みの Issue が見つからず、毎回 docs/ 全体が起点に戻る）
const RESULT_COMMENT_HEADING = '## 実行結果'

// 公開リポジトリでは誰でもコメントできるため、権限を持つ人の実行結果コメントだけを「処理済み」の目印にする
const TRUSTED_AUTHOR_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])

// buildWeeklyIssueBody が書き出す HEAD SHA の行から、次回の起点として読み戻すための書式（1か所にまとめ、書き出す側と読み戻す側がずれないようにする）
const HEAD_SHA_LINE_PREFIX = '起票時点の既定ブランチの HEAD は'
const HEAD_SHA_LINE_PATTERN = new RegExp(`${HEAD_SHA_LINE_PREFIX} \`([0-9a-f]{7,40})\``)

// 処理済みの週次 Issue を探して遡る最大件数。週次頻度なら約2年分で、これを超えて未処理のまま
// 閉じた Issue が続くと docs/ 全体へ静かにフォールバックする
const WEEKLY_ISSUE_LOOKUP_LIMIT = 100

// GitHub の Issue 本文の上限文字数。変更ファイルが多すぎて超えるときは docs/ 全体にフォールバックする
const GITHUB_ISSUE_BODY_MAX_LENGTH = 65536

function main() {
  if (hasOpenWeeklyIssue()) {
    console.log('起票しない（open な週次 Issue が既にある）')
    return
  }
  ensureLabelExists(WEEKLY_LABEL, '週次の docs/ 横断整合性チェック Issue', '5319E7')
  ensureLabelExists(
    'ai-fixable',
    '問題と対応方針が一意に定まり、AIが単独で対応できるIssue',
    '0E8A16'
  )

  const headSha = getCurrentHeadSha()
  const scope = decideCheckScope(headSha)
  if (!scope) {
    console.log('起票しない（前回処理以降に docs/ の変更が無い）')
    return
  }
  console.log(fileWeeklyIssue(buildWeeklyIssueBody(headSha, scope)))
}

/**
 * 今回の週次チェックの対象範囲を決める。
 *
 * 処理済みの週次 Issue が無い・本文から SHA を読み取れない・SHA がこのリポジトリに無い
 * （履歴の書き換えなど）場合は docs/ 全体を対象にする。前回処理以降に docs/ の変更が無い
 * 場合は null を返し、起票しないと呼び出し側に判断させる。
 *
 * @param {string} headSha 今回のチェックの終点にする HEAD SHA
 * @returns {{ kind: 'all' } | { kind: 'changedFiles', files: string[] } | null} 対象範囲。files は必ず1件以上
 */
function decideCheckScope(headSha) {
  const lastProcessedSha = findLastProcessedWeeklyIssueSha()
  if (!lastProcessedSha || !isCommitAvailable(lastProcessedSha)) return { kind: 'all' }

  const files = computeChangedDocFilesBetween(lastProcessedSha, headSha)
  return files.length === 0 ? null : { kind: 'changedFiles', files }
}

/**
 * ラベルが無ければ作る。
 *
 * @param {string} name ラベル名
 * @param {string} description ラベルの説明
 * @param {string} color ラベルの色（16進6桁、先頭 `#` 無し）
 * @returns {void}
 */
function ensureLabelExists(name, description, color) {
  const existingLabelNames = gh([
    'label',
    'list',
    '--limit',
    '200',
    '--json',
    'name',
    '--jq',
    '.[].name'
  ])
  if (existingLabelNames.split('\n').includes(name)) return
  gh(['label', 'create', name, '--description', description, '--color', color])
}

/**
 * 週次 Issue を起票する。
 *
 * @param {string} body Issue 本文
 * @returns {string} 起票した Issue の URL
 */
function fileWeeklyIssue(body) {
  return gh([
    'issue',
    'create',
    '--title',
    WEEKLY_ISSUE_TITLE,
    '--label',
    `ai-fixable,${WEEKLY_LABEL}`,
    '--body',
    body
  ]).trim()
}

/**
 * gh を実行して標準出力を返す。
 *
 * @param {string[]} args gh に渡す引数
 * @returns {string} 標準出力
 */
function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8' })
}

/**
 * open な週次 Issue が既にあるかを返す。起票の直後の Issue も数える。
 *
 * @returns {boolean} open な週次 Issue があれば true
 */
function hasOpenWeeklyIssue() {
  // gh issue list --label は検索 API 経由で、起票直後は結果整合の遅延で漏れるため issues 一覧（REST）を使う
  const openWeeklyIssueCount = gh([
    'api',
    `repos/{owner}/{repo}/issues?labels=${WEEKLY_LABEL}&state=open`,
    '--jq',
    'map(select(.pull_request == null)) | length'
  ]).trim()
  return Number(openWeeklyIssueCount) > 0
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
  const issues = JSON.parse(
    gh([
      'issue',
      'list',
      '--label',
      WEEKLY_LABEL,
      '--state',
      'all',
      '--json',
      'number,body,createdAt',
      '--limit',
      String(WEEKLY_ISSUE_LOOKUP_LIMIT)
    ])
  )
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
  const { comments } = JSON.parse(gh(['issue', 'view', String(issueNumber), '--json', 'comments']))
  return comments.some(
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
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * 指定した2つの SHA の間で変わった `docs/**\/*.md` の一覧を返す。
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
    ['diff', '--name-status', '-z', '-M', fromSha, toSha, '--', 'docs'],
    { encoding: 'utf8' }
  )
  const fields = nameStatusOutput.split('\0').filter((field) => field.length > 0)

  const changedFiles = []
  for (let i = 0; i < fields.length;) {
    const status = fields[i]
    const isRenameOrCopy = status.startsWith('R') || status.startsWith('C')
    const pathFieldCount = isRenameOrCopy ? 2 : 1
    const path = fields[i + pathFieldCount]
    i += 1 + pathFieldCount

    if (status.startsWith('D')) continue
    if (path.endsWith('.md')) changedFiles.push(path)
  }
  return changedFiles
}

/**
 * リポジトリのローカル HEAD の SHA を返す。
 *
 * @returns {string} コミット SHA
 */
function getCurrentHeadSha() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
}

/**
 * 週次 Issue の本文を組み立てる。長さが GitHub の Issue 本文の上限を超える場合は、
 * 対象範囲を docs/ 全体に落として作り直す。
 *
 * @param {string} headSha 起票時点の HEAD の SHA
 * @param {{ kind: 'all' } | { kind: 'changedFiles', files: string[] }} scope 対象範囲
 * @returns {string} Issue 本文
 */
function buildWeeklyIssueBody(headSha, scope) {
  const body = renderWeeklyIssueBody(headSha, scope)
  if (body.length <= GITHUB_ISSUE_BODY_MAX_LENGTH) return body
  return renderWeeklyIssueBody(headSha, { kind: 'all' })
}

/**
 * 週次 Issue の本文を描画する。
 *
 * @param {string} headSha 起票時点の HEAD の SHA
 * @param {{ kind: 'all' } | { kind: 'changedFiles', files: string[] }} scope 対象範囲
 * @returns {string} Issue 本文
 */
function renderWeeklyIssueBody(headSha, scope) {
  const isFullScope = scope.kind === 'all'
  const targetDocsSection = isFullScope
    ? 'docs/ 全体'
    : scope.files.map((path) => `  - \`${path}\``).join('\n')
  const docConsistencyCommand = isFullScope
    ? '/doc-consistency'
    : `/doc-consistency ${scope.files.join(' ')}`

  return `## この変更が必要な理由

docs/ 配下の文書は、差分レビューでは変更行しか見ないため、文書をまたぐ重複・矛盾を拾えない。
このIssueは、週1回そのギャップを埋めるために自動起票された定期チェックである。
放置すると、劣化した文書を手本に AI が横展開し、重複・矛盾が加速度的に増える。

## 対応方針

**採る案**：\`${docConsistencyCommand}\` を実行し、下記の対象箇所を横断チェックする。

**根拠**：このIssueは定期チェックとして自動起票されたものであり、対応方針は起票時点で固定されている。

**却下した案**：なし（自動起票のため、この Issue 自体に案の比較は無い）。

## タスク一覧

- [ ] \`${docConsistencyCommand}\` を実行する
- [ ] 実行結果を \`${RESULT_COMMENT_HEADING}\` から始まるコメントとして残す（起票した Issue の番号。0件なら「0件」と書く）

## 完了条件

- [ ] \`${RESULT_COMMENT_HEADING}\` から始まるコメントが残っている

## 現状

- **対象箇所**：
${targetDocsSection}
- **確認済み**：${HEAD_SHA_LINE_PREFIX} \`${headSha}\`
- **未確認**：なし
- **却下した案**：なし

## 実装フロー（使用するSkill）

| 順  | 変更種別         | 使用Skill             |
| --- | ---------------- | ---------------------- |
| 1   | 定期チェックの実行 | \`${docConsistencyCommand}\` |

## ブロッカー

なし（すぐ着手できる）
`
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
