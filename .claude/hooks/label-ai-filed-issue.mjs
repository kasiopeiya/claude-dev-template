#!/usr/bin/env node
// PostToolUse hook: AI が Bash で `gh issue create` を打った直後に、できた Issue へ `ai-filed-issue` ラベルを付ける。
//
// 設計意図（WHY）:
// - 人間と AI は同じ GitHub アカウントで起票するので、あとから「AI が起票した」かは GitHub の記録から分けられない。
//   AI が打ったという事実は、起票コマンドを打つその瞬間にしか取れない（policy-driven-development-policy「hook にしてよい役割」）。
// - Skill ごとに `--label` を足す案は、起票コマンドを書いた Skill の数だけ漏れる。hook 1か所なら漏れない。
// - `wake-on-ci-failure.mjs` には混ぜない。あちらは結果を待つ処理（asyncRewake）を抱えており、混ぜると記録まで待ちに巻き込まれる。
// - 付けるのは、コマンドが `gh issue create` と COMPANION_COMMANDS だけでできているときに限る。
//   無関係な Issue へ利用者の gh 権限でラベルを付けるより、付け損ねる方を選ぶ。
//   印が無いことは「人間が起票した」とは読まない決まりなので、付け損ねは許される（issue-policy「Issue に付けるラベル」）。
// - Issue は URL で指定する。`--repo` 付きの起票でも、起票先のリポジトリへ正しく付き、cwd に依存しない。
// - 無人実行（auto-programmer）の起票も AI の起票なので、無人のセッションを除外しない。
// - 何があっても標準エラー出力へ書かず、0 で終わる（fail-open）。PostToolUse の失敗は AI へ返るため、
//   ラベル付けの失敗で作業を止めない。
// - ラベル `ai-filed-issue` は scripts/setup-labels.sh が作る。起票先のリポジトリに無いと付け損ね、
//   fail-open なので何も出さずに終わる。付かないときは、まずラベルがあるかを見る。
// - 打ち切り時間は、`.claude/settings.json` の timeout（秒）を「GH_CALL_TIMEOUT_MS × MAX_LABELED_ISSUES」に余裕を足した値にしてある。
//   どちらかを上げたら、もう一方も上げる。

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { normalizeCommandStart, splitCommandStageTokens } from './shellSplit.mjs'

const hookDirectory = dirname(fileURLToPath(import.meta.url))

const AI_FILED_LABEL = 'ai-filed-issue'

// `gh issue create` が成功すると、標準出力に、できた Issue の URL が1行で出る。
// 行全体がこの形のものだけを拾う（`…/issues/12#issuecomment-3` のような別物は拾わない）。
// owner と repo は GitHub で使える文字に絞る
const ISSUE_URL_LINE = /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/issues\/\d+$/

// 起票コマンドに添えてよいコマンド（作業ディレクトリの移動と、変数の表示）。
// Issue の本文を読む `cat`・`curl`・`gh` の別コマンドのように、他の Issue の URL を出しうるものは入れない
const COMPANION_COMMANDS = new Set(['cd', 'echo', 'printf'])

// 添えるコマンド・代入だけの段に許さない文字。`;`・括弧は、引用符の内側にあるコマンド置換の跡で
// （splitCommandStageTokens は置換の始まりを `;` に置き換え、引用符の内側は区切らない）、その中のコマンドの出力は標準出力へ出る。
// `<`・`>` はプロセス置換 `>(…)` の入口になる
const SUBSTITUTION_MARKS = /[;()<>]/

// プロセス置換は、どの段に付いても中のコマンドの出力を標準出力へ流す
const PROCESS_SUBSTITUTION = /[<>]\(/

// 1回の Bash でラベルを付ける Issue の件数の上限。起票を1コマンドに束ねる使い方は、通常は数件で足りる
const MAX_LABELED_ISSUES = 5

// 固まったまま作業を止めないための値で、実測の裏付けは無い目安
const GH_CALL_TIMEOUT_MS = 15 * 1000

function main() {
  const { command, stdout } = readHookInput()
  if (!isOnlyGhIssueCreate(command)) return
  addAiFiledLabelToEach(findIssueUrls(stdout))
}

/**
 * 標準入力から hook の入力を読み、判定に使う欄を取り出す。
 *
 * @returns {{ command: unknown, stdout: unknown }} Bash のコマンドと標準出力（型は呼び出し先で確かめる）
 * @throws {SyntaxError} 標準入力が JSON でないとき
 */
function readHookInput() {
  const hookInput = JSON.parse(readFileSync(0, 'utf8'))
  return { command: hookInput?.tool_input?.command, stdout: hookInput?.tool_response?.stdout }
}

/**
 * Bash のコマンドが、`gh issue create` を実行し、ほかに Issue の URL を持ち込みうる段を含まないかを判定する。
 *
 * 添えてよいのは、代入だけの段（`url=$(gh issue create …)` の `url=`）と COMPANION_COMMANDS の段である。
 * 添える段にコマンド置換・プロセス置換・リダイレクトがあれば、その中で別のコマンドが動くので認めない。
 *
 * @param {unknown} command Bash ツールに渡されたコマンド
 * @returns {boolean} `gh issue create` の段があり、残りの段が添えてよい段だけなら true。ほかのコマンドが混ざる・コマンドが文字列でないときは false
 */
function isOnlyGhIssueCreate(command) {
  if (typeof command !== 'string') return false
  const stages = splitCommandStageTokens(command).map((stageTokens) => ({
    stageText: stageTokens.join(' '),
    commandTokens: normalizeCommandStart(stageTokens)
  }))
  return (
    stages.some(({ commandTokens }) => isGhIssueCreateStage(commandTokens)) &&
    stages.every(isAcceptableStage)
  )
}

/**
 * 段のトークン列が `gh issue create` かを判定する。
 *
 * @param {string[]} commandTokens `normalizeCommandStart` を通した、段のトークン列
 * @returns {boolean} `gh issue create` なら true
 */
function isGhIssueCreateStage([commandName, subcommand, action]) {
  return commandName === 'gh' && subcommand === 'issue' && action === 'create'
}

/**
 * 段が、ラベルを付けてよいコマンドの一部として認められるかを判定する。
 *
 * @param {{ stageText: string, commandTokens: string[] }} stage 段の全トークンをつないだ文字列と、実行されるコマンドから始まるトークン列
 * @returns {boolean} `gh issue create`（プロセス置換なし）、または添えてよい段（置換・リダイレクトなし）なら true
 */
function isAcceptableStage({ stageText, commandTokens }) {
  if (isGhIssueCreateStage(commandTokens)) return !PROCESS_SUBSTITUTION.test(stageText)
  const isAssignmentOnlyOrCompanion =
    commandTokens.length === 0 || COMPANION_COMMANDS.has(commandTokens[0])
  return isAssignmentOnlyOrCompanion && !SUBSTITUTION_MARKS.test(stageText)
}

/**
 * コマンドの標準出力から、Issue の URL だけの行を取り出す。
 *
 * @param {unknown} stdout Bash ツールの標準出力
 * @returns {string[]} Issue の URL（重複を除く。MAX_LABELED_ISSUES 件まで）。標準出力が文字列でないときは空
 */
function findIssueUrls(stdout) {
  if (typeof stdout !== 'string') return []
  const issueUrls = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => ISSUE_URL_LINE.test(line))
  return [...new Set(issueUrls)].slice(0, MAX_LABELED_ISSUES)
}

/**
 * 渡された Issue すべてへラベルを付ける。例外は投げない（付けられなかった件は飛ばし、残りを続ける）。
 *
 * @param {string[]} issueUrls Issue の URL
 */
function addAiFiledLabelToEach(issueUrls) {
  for (const issueUrl of issueUrls) {
    try {
      addAiFiledLabel(issueUrl)
    } catch {
      // 付けられなかった Issue があっても、作業は止めない（fail-open）
    }
  }
}

/**
 * Issue に `ai-filed-issue` ラベルを付ける。失敗したら例外を投げる。
 *
 * @param {string} issueUrl Issue の URL
 * @throws {Error} gh を起動できない・0 以外で終わった・GH_CALL_TIMEOUT_MS を超えたとき
 */
function addAiFiledLabel(issueUrl) {
  execFileSync('gh', ['issue', 'edit', issueUrl, '--add-label', AI_FILED_LABEL], {
    // Windows は実行ファイルを PATH より先に作業ディレクトリから探す。信頼できない cwd にしないため、hook の置き場所に固定する
    cwd: hookDirectory,
    stdio: 'ignore',
    timeout: GH_CALL_TIMEOUT_MS
  })
}

try {
  main()
} catch {
  // 入力を読めない・判定できないときは何もしない（fail-open）
}
