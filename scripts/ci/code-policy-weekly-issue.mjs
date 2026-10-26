#!/usr/bin/env node
// 責務: open な週次コード Policy 準拠チェック Issue が無いときだけ、その Issue を起票する。
//   起点は計算せず、毎週 app/ 配下のコード全体を対象にする（samples/ は対象外）。
//   ラベルの作成から起票まで自分で行い、呼び出し側の GitHub Actions
//   （.github/workflows/code-policy-weekly.yml）にはこのファイルを1回呼ぶことだけを残す。
//   設計判断の理由は scripts/auto-programmer/README.md「週次スクリプトが Issue を供給する」を参照。
//
// 使い方:
//   node scripts/ci/code-policy-weekly-issue.mjs   起票したら、その URL を標準出力に返す。
//                                                 次のどちらかに当たるときは起票せず、その理由を標準出力に返す：
//                                                 open な週次 Issue がある／対象ファイルが0件

import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

import { TechnicalError } from '../lib/errors.mjs'
import {
  GITHUB_ISSUE_BODY_MAX_LENGTH,
  assertEmbeddablePaths,
  createIssue,
  ensureLabelExists,
  hasOpenIssueWithLabel
} from './weekly-issue-filing.mjs'

// 対象ディレクトリの存在確認・git ls-files はこのディレクトリを基準にする（カレントディレクトリに依存させない）
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const WEEKLY_ISSUE_LABEL = 'code-policy-weekly'
const AI_FIXABLE_LABEL = 'ai-fixable'

// レビュー対象のディレクトリ。samples/ は参照実装で AI が書き換えられないため含めない
const TARGET_DIRECTORIES = ['app']

const WEEKLY_ISSUE_TITLE = `週次: ${TARGET_DIRECTORIES.join('・')} の Policy 準拠チェック (/code-review)`

const REVIEW_TARGET_SUFFIXES = ['.ts', '.tsx', '.test.mjs']

// REVIEW_TARGET_SUFFIXES の .ts と重なるため、除外を後段で効かせる
const REVIEW_EXCLUDED_SUFFIXES = ['.config.ts', '.config.js']

// 週次 Issue で実行を依頼するレンズ（理由は scripts/auto-programmer/README.md 参照）
const REVIEW_LENSES = ['決まりどおりか', '設計の形']

const RESULT_COMMENT_HEADING = '## 実行結果'

function main() {
  if (hasOpenIssueWithLabel(WEEKLY_ISSUE_LABEL)) {
    console.log('起票しない（open な週次 Issue が既にある）')
    return
  }

  const targetFiles = listTargetFiles()
  if (targetFiles.length === 0) {
    console.log('起票しない（対象ファイルが0件）')
    return
  }

  ensureLabelExists({
    name: WEEKLY_ISSUE_LABEL,
    description: '週次のコード Policy 準拠チェック Issue',
    color: 'B60205'
  })
  ensureLabelExists({
    name: AI_FIXABLE_LABEL,
    description: '問題と対応方針が一意に定まり、AIが単独で対応できるIssue',
    color: '0E8A16'
  })

  const issueUrl = createIssue({
    title: WEEKLY_ISSUE_TITLE,
    labelNames: [AI_FIXABLE_LABEL, WEEKLY_ISSUE_LABEL],
    body: buildWeeklyIssueBody(targetFiles)
  })
  console.log(issueUrl)
}

/**
 * 対象ディレクトリの git 管理下から、レビュー対象ファイルの一覧を返す。
 *
 * @returns {string[]} 対象ファイルパスの一覧（リポジトリルートからの相対パス、ソート済み）
 * @throws {BusinessError} Issue 本文に埋め込めない文字（改行など）を含むパスがあるとき
 */
function listTargetFiles() {
  const files = TARGET_DIRECTORIES.filter((directory) =>
    existsSync(resolve(repoRoot, directory))
  ).flatMap((directory) => listGitTrackedFiles(directory))
  const targetFiles = files
    .filter((path) => REVIEW_TARGET_SUFFIXES.some((suffix) => path.endsWith(suffix)))
    .filter((path) => !REVIEW_EXCLUDED_SUFFIXES.some((suffix) => path.endsWith(suffix)))
    .sort()

  assertEmbeddablePaths(targetFiles)
  return targetFiles
}

/**
 * 指定ディレクトリ配下の git 管理下ファイルの一覧を返す。
 *
 * @param {string} directory 対象ディレクトリ（リポジトリルートからの相対パス）
 * @returns {string[]} ファイルパスの一覧（リポジトリルートからの相対パス）
 */
function listGitTrackedFiles(directory) {
  // -z（NUL区切り）でないと、日本語などASCII外のパスが core.quotePath でクォートされる
  const output = execFileSync('git', ['ls-files', '-z', '--', directory], {
    cwd: repoRoot,
    encoding: 'utf8'
  })
  return output.split('\0').filter((path) => path.length > 0)
}

/**
 * 週次 Issue の本文を組み立てる。
 *
 * @param {string[]} targetFiles 対象ファイルの一覧
 * @returns {string} Issue 本文
 * @throws {TechnicalError} 本文が GitHub の Issue 本文の上限を超えるとき
 */
function buildWeeklyIssueBody(targetFiles) {
  const targetFilesSection = targetFiles.map((path) => `  - \`${path}\``).join('\n')
  const reviewCommands = REVIEW_LENSES.map(
    (lens) => `/code-review --full --lens ${lens} ${targetFiles.join(' ')}`
  )
  const reviewTasks = reviewCommands.map((command) => `- [ ] \`${command}\` を実行する`).join('\n')
  const implementationFlowRows = reviewCommands
    .map((command, index) => `| ${index + 1}   | 定期チェックの実行 | \`${command}\` |`)
    .join('\n')

  const body = `## この変更が必要な理由

Policy・Rule（\`docs/policy/*.md\`・\`.claude/rules/*.md\`）を変えたときに違反になった既存コードは、コードに差分が出ないのでレビューに掛からない。
このIssueは、週1回そのギャップを埋めるために自動起票された定期チェックである。
放置すると、Policy を改善するほど「Policy に反した手本」がコードベースに残り、AI がそれを写して劣化が加速する。

## 対応方針

**採る案**：下の対象箇所に \`/code-review\` を${REVIEW_LENSES.length}レンズ（${REVIEW_LENSES.join('・')}）で実行する。指摘は直さず \`/quick-issue\` で起票する。

**根拠**：このIssueは定期チェックとして自動起票されたものであり、対応方針は起票時点で固定されている。

**却下した案**：なし（自動起票のため、この Issue 自体に案の比較は無い）。

## タスク一覧

${reviewTasks}
- [ ] 指摘は直さず、全件を \`/quick-issue\` で起票する
- [ ] 実行結果を \`${RESULT_COMMENT_HEADING}\` から始まるコメントとして残す（起票した Issue の番号と所要実時間。指摘0件なら「0件」と書く）

## 完了条件

- [ ] \`${RESULT_COMMENT_HEADING}\` から始まるコメントが残っている

## 現状

- **対象箇所**：
${targetFilesSection}
- **却下した案**：なし

## 実装フロー（使用するSkill）

| 順  | 変更種別           | 使用Skill                  |
| --- | ------------------ | --------------------------- |
${implementationFlowRows}

## ブロッカー

なし（すぐ着手できる）
`

  // 対象ファイルが増えて上限を超えるときは、起票せず失敗させる
  // （冒頭の README の「起点を計算せず、毎週 app/ 全体を対象にする」が引き受けた制約。超えたら起点を差分計算に切り替える判断材料にする）
  if (body.length > GITHUB_ISSUE_BODY_MAX_LENGTH) {
    throw new TechnicalError(
      `週次 Issue 本文が ${body.length} 文字で GitHub の上限 ${GITHUB_ISSUE_BODY_MAX_LENGTH} を超える（対象 ${targetFiles.length} ファイル）。scripts/auto-programmer/README.md「週次スクリプトが Issue を供給する」の対象範囲（起点を計算せず全体を対象にする）を見直す`
    )
  }
  return body
}

try {
  main()
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
