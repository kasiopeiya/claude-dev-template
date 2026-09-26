#!/usr/bin/env node
// 責務: open な週次 docs/ 横断整合性チェック Issue が無いときだけ、その Issue を起票する。
//   （docs/adr/006-skip-weekly-issue-when-open.md）。ラベルの作成から起票まで自分で行い、
//   呼び出し側の GitHub Actions（.github/workflows/doc-consistency-weekly.yml）には
//   このファイルを1回呼ぶことだけを残す（判定に使うラベルと起票時に付けるラベルを
//   分けて持つと、一致を呼び出し側の約束に頼ることになるため）。
//
// 使い方:
//   node scripts/doc-consistency-weekly-issue.mjs   open な週次 Issue が無ければ起票し、URL を標準出力に返す。
//                                                     既にあれば起票せず、その旨を標準出力に返す

import { execFileSync } from 'child_process'
import { resolve } from 'path'
import { fileURLToPath } from 'url'

// 週次 Issue を見分ける専用ラベル
const WEEKLY_LABEL = 'doc-consistency-weekly'

const WEEKLY_ISSUE_TITLE = '週次: docs/ 横断の重複・矛盾チェック (/doc-consistency)'

// タスク一覧・完了条件・実行結果コメントの見出しを1か所で持つ
// TODO(#654): 処理済みの週次 Issue を探す目印としても使う
const RESULT_COMMENT_HEADING = '## 実行結果'

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
  console.log(fileWeeklyIssue(buildWeeklyIssueBody(fetchDefaultBranchHeadSha())))
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
 * リポジトリの既定ブランチの HEAD の SHA を返す。
 *
 * @returns {string} コミット SHA
 */
function fetchDefaultBranchHeadSha() {
  const defaultBranch = gh(['api', 'repos/{owner}/{repo}', '--jq', '.default_branch']).trim()
  return gh(['api', `repos/{owner}/{repo}/commits/${defaultBranch}`, '--jq', '.sha']).trim()
}

/**
 * 週次 Issue の本文を組み立てる。
 *
 * @param {string} defaultBranchHeadSha 起票時点の既定ブランチの HEAD の SHA
 * @returns {string} Issue 本文
 */
function buildWeeklyIssueBody(defaultBranchHeadSha) {
  return `## この変更が必要な理由

docs/ 配下の文書は、差分レビューでは変更行しか見ないため、文書をまたぐ重複・矛盾を拾えない。
このIssueは、週1回そのギャップを埋めるために自動起票された定期チェックである。
放置すると、劣化した文書を手本に AI が横展開し、重複・矛盾が加速度的に増える。

## 対応方針

**採る案**：\`/doc-consistency\` を引数なしで実行し、docs/ 全体を対象に横断チェックする。

**根拠**：このIssueは定期チェックとして自動起票されたものであり、対応方針は起票時点で固定されている。

**却下した案**：なし（自動起票のため、この Issue 自体に案の比較は無い）。

## タスク一覧

- [ ] \`/doc-consistency\` を実行する
- [ ] 実行結果を \`${RESULT_COMMENT_HEADING}\` から始まるコメントとして残す（起票した Issue の番号。0件なら「0件」と書く）

## 完了条件

- [ ] \`${RESULT_COMMENT_HEADING}\` から始まるコメントが残っている

## 現状

- **対象箇所**：docs/ 全体
- **確認済み**：起票時点の既定ブランチの HEAD は \`${defaultBranchHeadSha}\`
- **未確認**：なし
- **却下した案**：なし

## 実装フロー（使用するSkill）

| 順  | 変更種別         | 使用Skill             |
| --- | ---------------- | ---------------------- |
| 1   | 定期チェックの実行 | \`/doc-consistency\` |

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
