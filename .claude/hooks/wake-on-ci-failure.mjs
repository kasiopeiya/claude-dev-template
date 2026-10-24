#!/usr/bin/env node
// PostToolUse hook（asyncRewake）: 対話セッションで AI が git push した後、その commit の CI を裏で待ち、
// 落ちたときだけ寝ているセッションを起こして `/auto-fix-ci` で直させる（または直さず報告させる）。
//
// 設計意図（WHY）:
// - 待つのは決定論（この hook）、直すのは AI（`/auto-fix-ci`）という分け方は、auto-programmer と同じにしている。
//   AI に待たせる案は、セッションが終わらない・待ち忘れる、の2点で採らない。
// - asyncRewake なので、AI のターンは待たずに終わる。起こすときは標準エラー出力へ文面を書いて exit 2 で終わる。
//   黙って終わる（exit 0）のは、起こす必要が無いときと、判定できないとき（fail-open）である。
// - run の判定は auto-programmer の ciRun.mjs を使い、待つループは共有しない。auto-programmer の待ちは
//   画面表示と Ctrl+C の中止を抱えており、ここには要らない。
// - 直させた回数は状態をファイルに持たず、起こす直前にそのブランチで落ちた run を数え直す。AI に数えさせると、
//   文脈が圧縮されたときに数え違える。
// - 作業ツリーは、環境変数 CLAUDE_PROJECT_DIR ではなく stdin の cwd で決める（sessionWorktreeRoot.mjs）。
// - auto-programmer が起動した無人のセッションでは何もしない。CI を待って直させるのは起動側で、
//   ここでも起こすと二重になる。
// - config.mjs はテンプレート同期の対象外で、利用先に `ci` が無いことがある。読めなければ何もしない。

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import {
  CI_RUN_STATE_FIELDS,
  countPastFixAttempts,
  decideAfterCiRun,
  readCiRunState
} from '../../scripts/auto-programmer/ciRun.mjs'
import {
  UNATTENDED_SESSION_ENV_NAME,
  UNATTENDED_SESSION_ENV_VALUE
} from '../../scripts/auto-programmer/unattendedSessionEnv.mjs'
import { readOriginDefaultBranchName } from './originDefaultBranch.mjs'
import { findSessionWorktreeRoot } from './sessionWorktreeRoot.mjs'
import {
  normalizeCommandStart,
  splitHeredoc,
  splitPipeStages,
  splitStatements,
  tokenize
} from './shellSplit.mjs'

const hookDirectory = dirname(fileURLToPath(import.meta.url))
// .claude/hooks/ からプロジェクトルートへ。cwd の作業ツリーが同じリポジトリかの比較に使う
const hookProjectRoot = resolve(hookDirectory, '../..')

const MILLISECONDS_PER_SECOND = 1000
const MILLISECONDS_PER_MINUTE = 60 * MILLISECONDS_PER_SECOND

// push しても run が1件も現れないときに、CI の対象外の push とみなして待ちをやめるまでの時間。
// pipeline.yml の push トリガーは決まった接頭辞のブランチだけで、それ以外のブランチでは run が作られない。
// 待ち上限いっぱいまで待つと、空振りで起こすことになる。5分は実測の裏付けが無い目安
const RUN_APPEARANCE_WAIT_MS = 5 * MILLISECONDS_PER_MINUTE

// git・gh 1回の呼び出しの上限。待ち全体の上限（config.ci.runWaitLimitMinutes）とは別で、1回が固まったままにしない
const COMMAND_TIMEOUT_MS = 30 * MILLISECONDS_PER_SECOND

// `gh run list` が返す件数の上限（既定は20）。ブランチで落ちた run を数えるために広げる
const BRANCH_RUN_LIST_LIMIT = 100

// 起こすときの exit code（Claude Code の hook 契約：asyncRewake は exit 2 でセッションを起こし、標準エラー出力を渡す）
const REWAKE_EXIT_CODE = 2

/**
 * 外部コマンドを実行して、前後の空白を除いた標準出力を返す。失敗したら例外を投げる。
 *
 * @param {string} command 実行するコマンド
 * @param {string[]} args 引数
 * @returns {string} 標準出力
 * @throws {Error} コマンドを起動できない・0 以外で終わった・COMMAND_TIMEOUT_MS を超えたとき
 */
function runCommand(command, args) {
  return execFileSync(command, args, {
    // Windows は実行ファイルを PATH より先に作業ディレクトリから探す。信頼できない cwd にしないため、hook の置き場所に固定する
    cwd: hookDirectory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: COMMAND_TIMEOUT_MS
  }).trim()
}

/**
 * 作業ツリーで git を実行する。
 *
 * @param {string} worktreeRoot 作業ツリーのルート
 * @param {string[]} gitArgs git の引数
 * @returns {string} 標準出力
 * @throws {Error} runCommand と同じ
 */
function runGit(worktreeRoot, gitArgs) {
  return runCommand('git', ['-C', worktreeRoot, ...gitArgs])
}

/**
 * Bash のコマンドに、実際に push する `git push` が含まれるかを判定する。
 *
 * @param {unknown} command Bash ツールに渡されたコマンド
 * @returns {boolean} 含まれていれば true（`--dry-run`・`-n` は push しないので除く）
 */
function isGitPush(command) {
  if (typeof command !== 'string') return false
  const { commandText } = splitHeredoc(command)
  return splitStatements(commandText)
    .flatMap(splitPipeStages)
    .some((stage) => {
      const [commandName, subcommand, ...options] = normalizeCommandStart(tokenize(stage))
      const isDryRun = options.includes('--dry-run') || options.includes('-n')
      return commandName === 'git' && subcommand === 'push' && !isDryRun
    })
}

/**
 * そのコマンドが、ブランチを実際に更新したかを、push の出力から判定する。
 *
 * 「リモートの先頭が手元の HEAD と同じ」は push が通ったことしか示さない。すでに push 済みの commit が先頭のまま
 * `git push` を打ち直す（Everything up-to-date）・タグだけを push する・別のブランチを push する場合に、同じ commit を
 * 見張る hook がもう1本走り、1つの失敗で何度も起こしてしまう。push の出力には、更新したブランチだけが
 * `<ローカル> -> <リモート>` の行で出る。
 *
 * @param {unknown} toolResponse hook の入力の tool_response（Bash ツールの stdout・stderr を持つ）
 * @param {string} branchName 見張るブランチ名
 * @returns {boolean} 更新の行があれば true。出力を読めないときは false
 */
function didPushUpdateBranch(toolResponse, branchName) {
  if (typeof toolResponse?.stdout !== 'string' || typeof toolResponse?.stderr !== 'string') {
    return false
  }
  return `${toolResponse.stdout}\n${toolResponse.stderr}`.split('\n').some((line) => {
    const [, remoteSide] = line.split('->')
    return remoteSide?.trim().split(/\s+/)[0] === branchName
  })
}

/**
 * リモートのブランチの先頭の SHA を返す。
 *
 * @param {string} worktreeRoot 作業ツリーのルート
 * @param {string} branchName ブランチ名
 * @returns {string | null} SHA。リモートにブランチが無いときは空文字、引けなかったときは null
 */
function readRemoteBranchSha(worktreeRoot, branchName) {
  try {
    const refLine = runGit(worktreeRoot, ['ls-remote', 'origin', `refs/heads/${branchName}`])
    return refLine.split('\t')[0]
  } catch {
    return null
  }
}

/**
 * 今のブランチの先頭が push されているかを確かめ、push したブランチと SHA を返す。
 *
 * @param {string} worktreeRoot 作業ツリーのルート
 * @param {string} defaultBranchName デフォルトブランチ名（その push は CI の見張りの対象にしない）
 * @returns {{ branchName: string, headSha: string } | null} 見張る対象。デフォルトブランチ・push が通っていない（リモートの先頭が手元の HEAD と違う）ときは null
 * @throws {Error} HEAD がブランチを指していない（detached）ときと、git が失敗したとき
 */
function readPushedBranch(worktreeRoot, defaultBranchName) {
  const branchName = runGit(worktreeRoot, ['symbolic-ref', '--short', 'HEAD'])
  if (branchName === defaultBranchName) return null
  const headSha = runGit(worktreeRoot, ['rev-parse', 'HEAD'])
  return readRemoteBranchSha(worktreeRoot, branchName) === headSha ? { branchName, headSha } : null
}

/**
 * push したブランチ自身の最新のコミット（merge を除く）の件名末尾 `(#番号)` から、Issue 番号を読む。
 *
 * ブランチの第1親だけをたどる。デフォルトブランチを取り込んだ直後は、日付順だと取り込んだ側のコミットが先に来る。
 *
 * 起こす直前の HEAD ではなく、見張った commit から読む。待つ間に人間が別のブランチや別の Issue の作業を始めていることがある。
 *
 * @param {string} worktreeRoot 作業ツリーのルート
 * @param {{ defaultBranchName: string, headSha: string }} pushed デフォルトブランチ名と、見張った commit の SHA
 * @returns {number | null} Issue 番号。読めなければ null
 */
function readIssueNumber(worktreeRoot, { defaultBranchName, headSha }) {
  try {
    const subject = runGit(worktreeRoot, [
      'log',
      '--first-parent',
      '--no-merges',
      '--max-count=1',
      '--format=%s',
      `origin/${defaultBranchName}..${headSha}`
    ])
    const matched = /\(#(\d+)\)\s*$/.exec(subject)
    return matched ? Number(matched[1]) : null
  } catch {
    return null
  }
}

/**
 * @typedef {{ repository: string, workflowFile: string, pollIntervalSeconds: number, runWaitLimitMinutes: number, maxFixAttempts: number }} CiSettings
 */

/**
 * config.mjs の `ci` から、この hook が使う項目を取り出す。
 *
 * @param {{ ci?: Record<string, unknown>, repository?: unknown }} config config.mjs の config
 * @returns {CiSettings | null} 項目がそろっていなければ null
 */
function pickCiSettings(config) {
  const { repository, ci } = config
  if (typeof repository !== 'string' || !ci) return null
  const { workflowFile, pollIntervalSeconds, runWaitLimitMinutes, maxFixAttempts } = ci
  const hasAllSettings =
    typeof workflowFile === 'string' &&
    [pollIntervalSeconds, runWaitLimitMinutes, maxFixAttempts].every(Number.isFinite)
  return hasAllSettings
    ? { repository, workflowFile, pollIntervalSeconds, runWaitLimitMinutes, maxFixAttempts }
    : null
}

/**
 * `gh run list` を実行して JSON で受け取る。
 *
 * @param {CiSettings} ciSettings 対象のリポジトリとワークフロー
 * @param {{ filterArgs: string[], fields: string }} query 絞り込みの引数と、受け取る項目
 * @returns {unknown[]} run の一覧
 * @throws {Error} gh が失敗したとき・出力が JSON でないとき
 */
function listCiRuns({ repository, workflowFile }, { filterArgs, fields }) {
  const output = runCommand('gh', [
    'run',
    'list',
    '--repo',
    repository,
    '--workflow',
    workflowFile,
    ...filterArgs,
    '--json',
    fields
  ])
  return JSON.parse(output)
}

/**
 * push した commit の run の状態を読む。引けなかったときは例外にせず null を返す（次の周で引き直す）。
 *
 * @param {CiSettings} ciSettings 対象のリポジトリとワークフロー
 * @param {string} headSha 待っている commit の SHA
 * @returns {ReturnType<typeof readCiRunState> | null} run の状態。引けなければ null
 */
function tryReadCiRunState(ciSettings, headSha) {
  try {
    const runs = listCiRuns(ciSettings, {
      // --branch は付けない。--commit と併せると、該当する run があっても空で返る
      filterArgs: ['--commit', headSha],
      fields: CI_RUN_STATE_FIELDS
    })
    return readCiRunState(runs, headSha)
  } catch {
    return null
  }
}

/**
 * push した commit の run が終わるまで待つ。待ち時間は run が現れるまでを含めた通しで数える。
 *
 * @param {CiSettings} ciSettings 対象のリポジトリ・ワークフロー・待ちの設定
 * @param {string} headSha 待っている commit の SHA
 * @returns {Promise<ReturnType<typeof readCiRunState> | null>} 終わった run の状態。待ち上限を使い切ったときは終わっていない状態（pending）。CI の対象外の push と見なしたときと、一度も引けなかったときは null
 */
async function waitForCiRunState(ciSettings, headSha) {
  const startedAt = Date.now()
  // .claude/settings.json の timeout（秒）は、この待ち上限に5分足した値にしてある。待ちの最後の gh の呼び出しや、
  // 待ったあとの git・gh の呼び出しが上限をまたいでも、起こす前に打ち切られないための余裕。上限を上げたら timeout も上げる
  const deadline = startedAt + ciSettings.runWaitLimitMinutes * MILLISECONDS_PER_MINUTE
  let lastPendingState = null
  for (;;) {
    const runState = tryReadCiRunState(ciSettings, headSha)
    if (runState && runState.state !== 'pending') return runState
    if (runState) lastPendingState = runState
    if (runState?.runId === null && Date.now() - startedAt >= RUN_APPEARANCE_WAIT_MS) return null
    if (Date.now() >= deadline) return lastPendingState
    await sleep(ciSettings.pollIntervalSeconds * MILLISECONDS_PER_SECOND)
  }
}

/**
 * そのブランチで、これまでに `/auto-fix-ci` に直させた回数を数える。
 *
 * @param {CiSettings} ciSettings 対象のリポジトリとワークフロー
 * @param {{ branchName: string, currentRunId: number }} target ブランチ名と、いま見ている落ちた run の ID（数えない）
 * @returns {number} これまでに直させた回数
 * @throws {Error} gh が失敗したとき・出力が JSON でないとき
 */
function countPastFixAttemptsOnBranch(ciSettings, { branchName, currentRunId }) {
  const branchRuns = listCiRuns(ciSettings, {
    filterArgs: ['--branch', branchName, '--limit', String(BRANCH_RUN_LIST_LIMIT)],
    fields: 'databaseId,status,conclusion'
  })
  return countPastFixAttempts({ branchRuns, currentRunId })
}

/**
 * 起こす文面のうち、どの場合にも付ける事実の行を組み立てる。
 *
 * @param {{ ciSettings: CiSettings, pushedBranch: { branchName: string, headSha: string }, runState: { url: string | null } }} facts ワークフロー・push したブランチと SHA・run
 * @returns {string} 事実の行（改行区切り）
 */
function buildFactLines({ ciSettings, pushedBranch, runState }) {
  return [
    `- ワークフロー: ${ciSettings.workflowFile}`,
    `- ブランチ: ${pushedBranch.branchName}（${pushedBranch.headSha.slice(0, 7)}）`,
    `- run: ${runState.url ?? '見つかりませんでした'}`
  ].join('\n')
}

/**
 * @typedef {'fix' | 'hand-over' | 'stop-unfixable' | 'stop-timed-out' | 'unknown-fix-count'} WakeStep 起こす場合にすること。通ったときは起こさないので含まない。decideAfterCiRun の結果に、直させた回数を数えられなかったときを足したもの
 */

/**
 * 直さずに報告させるときの、理由の1行を組み立てる。
 *
 * @param {{ nextStep: WakeStep, runState: { conclusion: string | null }, ciSettings: CiSettings, failureCount: number }} situation decideAfterCiRun の結果・run・設定・何回落ちたか
 * @returns {string} 理由。nextStep が 'fix' のときは、直させたいのに Issue 番号を読めなかった場合である
 */
function describeReasonNotToFix({ nextStep, runState, ciSettings, failureCount }) {
  switch (nextStep) {
    case 'fix':
      return 'Issue 番号を、このブランチの最新のコミットの件名末尾 (#番号) から読めませんでした。推測では直させません'
    case 'hand-over':
      return `CI が ${failureCount} 回落ちました。/auto-fix-ci で ${ciSettings.maxFixAttempts} 回直させても通らなかったので、これ以上直させません`
    case 'stop-unfixable':
      return `run が ${runState.conclusion} で終わりました。差分の中身では直せない終わり方なので、直させません`
    case 'stop-timed-out':
      return `${ciSettings.runWaitLimitMinutes} 分待っても run が終わりませんでした`
    case 'unknown-fix-count':
      return 'このブランチで直させた回数を、gh で数えられませんでした。上限を超えて直させ続けないよう、直させません'
    default:
      return `想定外の判定（${nextStep}）が出たので、直させません`
  }
}

/**
 * 起こしたセッションに渡す文面を組み立てる。
 *
 * @param {{ nextStep: WakeStep, issueNumber: number | null, facts: Parameters<typeof buildFactLines>[0], failureCount: number }} situation decideAfterCiRun の結果・Issue 番号・事実・何回落ちたか
 * @returns {string} 標準エラー出力へ書く文面
 */
function buildWakeMessage({ nextStep, issueNumber, facts, failureCount }) {
  const factLines = buildFactLines(facts)
  if (nextStep === 'fix' && issueNumber !== null) {
    const { ciSettings, runState } = facts
    return [
      `push した commit の CI が落ちました（${failureCount} 回目の失敗。直させる上限は ${ciSettings.maxFixAttempts} 回）。`,
      factLines,
      `Skill ツールで /auto-fix-ci ${issueNumber} ${runState.runId} を実行してください。`
    ].join('\n')
  }
  const reason = describeReasonNotToFix({
    nextStep,
    runState: facts.runState,
    ciSettings: facts.ciSettings,
    failureCount
  })
  return [
    'push した commit の CI について、直さずに、このセッションで人間に報告してください。',
    `- 理由: ${reason}`,
    factLines
  ].join('\n')
}

/**
 * 見張る対象の push かを確かめる。
 *
 * @param {unknown} input hook の入力（JSON）
 * @returns {{ worktreeRoot: string, defaultBranchName: string, pushedBranch: { branchName: string, headSha: string } } | null} 見張る対象。対象でない・判定できないときは null
 * @throws {Error} HEAD がブランチを指していないとき・git が失敗したとき
 */
function findPushToWatch(input) {
  if (!isGitPush(input?.tool_input?.command)) return null
  if (process.env[UNATTENDED_SESSION_ENV_NAME] === UNATTENDED_SESSION_ENV_VALUE) return null
  const worktreeRoot = findSessionWorktreeRoot(input?.cwd, hookProjectRoot)
  if (!worktreeRoot) return null
  const defaultBranchName = readOriginDefaultBranchName(worktreeRoot)
  if (!defaultBranchName) return null
  const pushedBranch = readPushedBranch(worktreeRoot, defaultBranchName)
  if (!pushedBranch || !didPushUpdateBranch(input?.tool_response, pushedBranch.branchName)) {
    return null
  }
  return { worktreeRoot, defaultBranchName, pushedBranch }
}

/**
 * 落ちた run を見て、起こしたセッションにさせることを決める。
 *
 * @param {CiSettings} ciSettings 設定
 * @param {{ state: string, runId: number | null }} runState 待ち終えた run の状態（通ったときは渡さない）
 * @param {string} branchName 見張ったブランチ名
 * @returns {{ nextStep: WakeStep, pastFixAttemptCount: number }} すること。直させた回数を数えるのは、直せる失敗のときだけ
 */
function decideWakeStep(ciSettings, runState, branchName) {
  let pastFixAttemptCount = 0
  if (runState.state === 'fixable-failure') {
    try {
      pastFixAttemptCount = countPastFixAttemptsOnBranch(ciSettings, {
        branchName,
        currentRunId: runState.runId
      })
    } catch {
      return { nextStep: 'unknown-fix-count', pastFixAttemptCount }
    }
  }
  const nextStep = decideAfterCiRun({
    state: runState.state,
    fixAttemptCount: pastFixAttemptCount,
    maxFixAttempts: ciSettings.maxFixAttempts
  })
  return { nextStep, pastFixAttemptCount }
}

async function main() {
  const pushToWatch = findPushToWatch(JSON.parse(readFileSync(0, 'utf8')))
  if (!pushToWatch) return
  const { worktreeRoot, defaultBranchName, pushedBranch } = pushToWatch

  // 静的 import にしない。config.mjs が無い・読み込みで throw すると、モジュールの読み込みで落ちて末尾の catch に届かず、
  // push 以外も含む Bash の実行のたびに、この hook がエラーで終わってしまうため
  const { config } = await import('../../scripts/auto-programmer/config.mjs')
  const ciSettings = pickCiSettings(config)
  if (!ciSettings) return

  const runState = await waitForCiRunState(ciSettings, pushedBranch.headSha)
  if (!runState || runState.state === 'success') return
  // 待っている間に同じブランチへ push されたら、その push の hook が見張る。古い commit の結果では起こさない。
  // リモートの先頭を引けなかったときは追い越されたと見なさず、起こす側に倒す（知らせが消えるより、空振りの方が安い）
  const remoteSha = readRemoteBranchSha(worktreeRoot, pushedBranch.branchName)
  if (remoteSha !== null && remoteSha !== pushedBranch.headSha) return

  const { nextStep, pastFixAttemptCount } = decideWakeStep(
    ciSettings,
    runState,
    pushedBranch.branchName
  )
  const issueNumber = readIssueNumber(worktreeRoot, {
    defaultBranchName,
    headSha: pushedBranch.headSha
  })
  const facts = { ciSettings, pushedBranch, runState }
  const failureCount = pastFixAttemptCount + 1
  process.stderr.write(`${buildWakeMessage({ nextStep, issueNumber, facts, failureCount })}\n`)
  process.exitCode = REWAKE_EXIT_CODE
}

try {
  await main()
} catch {
  // 判定できないときは起こさない（fail-open）。
}
