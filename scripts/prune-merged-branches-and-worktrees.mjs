#!/usr/bin/env node
// 責務: PR がマージ済みで取り込み済みのローカルブランチを消し、それを抱える stale worktree もフォルダごと消す。
//   AI が Issue の着手時に打つ（いつ打つかは CLAUDE.md「Issue 作業の共通ルール」）。人間が手で打ってもよい。
//
// 使い方:
//   npm run prune-merged-branches-and-worktrees                消したブランチを標準出力に返す（外した worktree があれば、その行も返す）
//   npm run prune-merged-branches-and-worktrees -- --dry-run   何も消さず、消す予定のブランチだけを1件1行で返す（`--` は要る）
//   残したブランチがあれば、その理由を標準エラーに出し、終了コード 1 で終わる。
//   デフォルトブランチと PR は GitHub のリポジトリから引く（gh が要る。引き方は githubDefaultBranch.mjs）
//
// 設計意図（WHY）:
// - 次の Issue の着手時に打つ。自動マージは後から起き、ブランチを作ったセッションは片付けに戻らないため
// - 消すのは、デフォルトブランチへマージ済みの PR の作業と確かめたブランチだけ（判定は isCoveredByMergedPullRequest）。
//   PR の無いブランチ・PR がマージされていないブランチは、取り込み済みでも消す対象にしない（出力もしない）
// - 取り込み済みかの基準は `--merged origin/<デフォルトブランチ>`。引数なしの --merged は HEAD 基準になり、
//   トピックブランチ上では未 push の作業を巻き込む
// - 判定の前に自分で git fetch origin <デフォルトブランチ> を打つ（--dry-run でも打つ）。呼び出し側が事前に fetch する前提だと、
//   打ち忘れたときに取り込み済みのブランチを黙って消さずにおく
// - 削除は `-d` に限る。git 自身のマージ済みチェックが安全装置になる。-D は未マージの作業と専用 reflog を消すため使わない
//   （.claude/hooks/forbiddenCommandMatcher.mjs 冒頭）。`-d` は、ブランチの upstream（無い・消えていれば HEAD）に
//   取り込み済みかを確かめて拒む。worktree を外した後で拒まれると worktree だけが消えるので、外す前に同じ基準で確かめ、
//   満たさないブランチは worktree ごと残す
// - worktree は --force なしで外す。未コミットの変更があれば git が拒否し、そのブランチは残す
// - 生きている Claude Code セッションが中で作業している worktree は外さない（ブランチも残す）。着手時に AI が打つので、
//   マージ後も開いたままの別セッションの作業ディレクトリを消しうる。git は、別プロセスが作業ディレクトリにしている
//   worktree でも外してしまう。セッションの作業ディレクトリは会話ログの最後の cwd で見る。`cd` で移っても、
//   プロセスの cwd（lsof）と登録ファイルの cwd は起動したフォルダのままで、会話ログの cwd だけが追った（v2.1.310 で確認）。
//   EnterWorktree で移ったセッションの cwd を会話ログが追わなければ、そのセッションの worktree を見分けられず外す。
//   登録ファイルと会話ログは Claude Code の非公開の内部ファイルなので（読み方は liveClaudeSessions.mjs）、
//   読めない・cwd が見つからないときは、どのセッションがどこに居るか分からないものとして、
//   worktree を抱えるブランチをすべて残す
// - `--dry-run` は、消す前に対象を確かめるために置く。このスクリプトは動作確認をするだけでも実削除になるため
// - 消す操作なので、知らない引数は止める。打ち間違い（`--dryrun` など）が、そのまま実削除になるのを防ぐ
// - `npm run prune-merged-branches-and-worktrees --dry-run`（`--` 抜け）では、npm が --dry-run を自分の設定として吸い取り、
//   引数には残らず環境変数 npm_config_dry_run だけが立つ。確認のつもりが実削除にならないよう、これも dry-run とみなす

import { realpathSync } from 'node:fs'
import { sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readDefaultBranchName } from './githubDefaultBranch.mjs'
import { BusinessError, TechnicalError } from './lib/errors.mjs'
import {
  readLiveSessionWorkingDirectories,
  resolveClaudeConfigDirectory
} from './liveClaudeSessions.mjs'
import { runCommand } from './runCommand.mjs'

const KNOWN_OPTIONS = new Set(['--dry-run'])
const LOCAL_BRANCH_REF_PREFIX = 'refs/heads/'

/**
 * CLI として実行したときの本体。消したブランチと残したブランチ（`--dry-run` なら消す予定のブランチ）を出力し、
 * 残したものがあれば異常終了する。
 *
 * @returns {void}
 * @throws {BusinessError} 知らない引数があるとき
 * @throws {TechnicalError} origin やデフォルトブランチ・worktree の一覧を引けなかったとき（ブランチは1件も消さない）
 */
function runCli() {
  const { dryRun } = parseCliOptions(process.argv.slice(2), process.env)
  const configDirectory = resolveClaudeConfigDirectory(process.env)
  const { deletionTargets, keptCount } = planMergedBranchDeletions({ configDirectory })
  let failedCount = 0
  if (dryRun) printPlannedDeletions(deletionTargets)
  else failedCount = deleteBranches(deletionTargets)
  if (deletionTargets.length === 0 && keptCount === 0) console.log('消すブランチはありません')
  if (keptCount + failedCount > 0) process.exitCode = 1
}

/**
 * コマンドライン引数を読む。
 *
 * @param {string[]} args `--dry-run` などの引数（node とスクリプトのパスは含まない）
 * @param {Record<string, string | undefined>} env 環境変数
 * @returns {{ dryRun: boolean }} 読み取った指定
 * @throws {BusinessError} 知らない引数があるとき
 */
function parseCliOptions(args, env) {
  const unknownOptions = args.filter((cliArgument) => !KNOWN_OPTIONS.has(cliArgument))
  if (unknownOptions.length > 0) {
    throw new BusinessError(
      `知らない引数です: ${unknownOptions.join(' ')}（使えるのは --dry-run だけ）`
    )
  }
  return { dryRun: args.includes('--dry-run') || env.npm_config_dry_run === 'true' }
}

/**
 * 消すブランチを決める。何も消さない。残すブランチは、理由を標準エラーに出す。
 * 判定の順は、取り込み済みの候補 → マージ済み PR の作業 → セッションが作業中でなく、`git branch -d` が通る。
 *
 * @param {{ configDirectory: string }} params configDirectory: Claude Code の設定ディレクトリ
 * @returns {{ deletionTargets: { branch: string, worktreePath: string | undefined }[], keptCount: number }}
 *   消すブランチ（抱えている worktree の場所つき）と、残した件数（PR を確かめられなかったものを含む）
 * @throws {TechnicalError} origin・デフォルトブランチ・worktree の一覧を引けなかったとき
 */
function planMergedBranchDeletions({ configDirectory }) {
  const { originUrl, defaultBranchName } = fetchOriginDefaultBranch()
  const { mainWorktreeBranch, worktreePathByBranch } = readWorktreeLayout()
  const protectedBranches = listProtectedBranches({ defaultBranchName, mainWorktreeBranch })
  const sessionWorkingDirectories = readSessionWorkingDirectoriesOrUndefined(configDirectory)
  const mergedCandidateBranches = listMergedCandidateBranches({
    defaultBranchName,
    protectedBranches
  })
  const { coveredBranches, uncheckedCount } = selectBranchesCoveredByMergedPullRequest({
    originUrl,
    defaultBranchName,
    branches: mergedCandidateBranches
  })
  const { deletionTargets, keptCount } = selectDeletionTargets({
    coveredBranches,
    worktreePathByBranch,
    sessionWorkingDirectories
  })
  return { deletionTargets, keptCount: keptCount + uncheckedCount }
}

/**
 * origin の URL とデフォルトブランチ名を引き、デフォルトブランチの最新を fetch する。
 *
 * @returns {{ originUrl: string, defaultBranchName: string }} origin の URL とデフォルトブランチ名
 * @throws {TechnicalError} origin・デフォルトブランチを引けなかったとき・fetch が失敗したとき
 */
function fetchOriginDefaultBranch() {
  // デフォルトブランチも PR も、取り込み済みの基準 origin/<名前> と同じリポジトリから引く。
  // gh の既定（`upstream` や `GH_REPO`）に任せると、別のリポジトリを見る
  const originUrl = runGit(['remote', 'get-url', 'origin'])
  const defaultBranchName = readDefaultBranchName(originUrl)
  runGit(['fetch', 'origin', '--end-of-options', defaultBranchName])
  return { originUrl, defaultBranchName }
}

/**
 * メインの作業フォルダのブランチと、メイン以外の worktree が抱えるブランチの場所を、`git worktree list` から読む。
 *
 * @returns {{ mainWorktreeBranch: string | undefined, worktreePathByBranch: Map<string, string> }}
 *   mainWorktreeBranch: メインの作業フォルダのブランチ（detached HEAD などブランチが無ければ undefined）/
 *   worktreePathByBranch: メイン以外の worktree が抱えるブランチと、その場所
 * @throws {TechnicalError} git が失敗したとき・出力の形が想定と違うとき
 */
function readWorktreeLayout() {
  const [mainWorktree, ...linkedWorktrees] = runGit(['worktree', 'list', '--porcelain'])
    .split('\n\n')
    .map(parseWorktreeBlock)
  const worktreePathByBranch = new Map(
    linkedWorktrees
      .filter((worktree) => worktree.branch)
      .map((worktree) => [worktree.branch, worktree.path])
  )
  return { mainWorktreeBranch: mainWorktree.branch, worktreePathByBranch }
}

/**
 * 消さないブランチを挙げる。
 *
 * @param {{ defaultBranchName: string, mainWorktreeBranch: string | undefined }} params
 *   defaultBranchName: デフォルトブランチ名 / mainWorktreeBranch: メインの作業フォルダのブランチ
 * @returns {Set<string>} デフォルトブランチ・いまのブランチ・メインの作業フォルダのブランチ
 * @throws {TechnicalError} git が失敗したとき
 */
function listProtectedBranches({ defaultBranchName, mainWorktreeBranch }) {
  const currentBranch = runGit(['branch', '--show-current'])
  return new Set([defaultBranchName, currentBranch, mainWorktreeBranch].filter(Boolean))
}

/**
 * `git worktree list --porcelain` の1作業フォルダ分を読む。
 *
 * @param {string} block 作業フォルダ1件分の出力（空行で区切られた1ブロック）
 * @returns {{ path: string, branch: string | undefined }}
 *   作業フォルダの場所と、チェックアウト中のブランチ名（detached HEAD などブランチが無ければ undefined）
 * @throws {TechnicalError} ブロックに `worktree` の行が無いとき
 */
function parseWorktreeBlock(block) {
  const lines = block.split('\n')
  const path = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length)
  if (path === undefined) {
    throw new TechnicalError(`git worktree list の出力に worktree の行がありません: ${block}`)
  }
  const ref = lines.find((line) => line.startsWith('branch '))?.slice('branch '.length)
  return { path, branch: ref?.replace(/^refs\/heads\//, '') }
}

/**
 * 生きている Claude Code セッションの作業ディレクトリを集める。集められなければ、理由を標準エラーに出して undefined を返す。
 *
 * @param {string} configDirectory Claude Code の設定ディレクトリ
 * @returns {string[] | undefined} 作業ディレクトリ。分からなければ undefined（worktree を抱えるブランチをすべて残すために使う）
 */
function readSessionWorkingDirectoriesOrUndefined(configDirectory) {
  try {
    return readLiveSessionWorkingDirectories(configDirectory)
  } catch (error) {
    console.error(
      `セッションの作業ディレクトリを確かめられないので、worktree は外さない: ${error.message}`
    )
    return undefined
  }
}

/**
 * origin/<デフォルトブランチ> に取り込み済みのローカルブランチを、消す候補として挙げる。
 *
 * @param {{ defaultBranchName: string, protectedBranches: Set<string> }} params
 *   defaultBranchName: デフォルトブランチ名 / protectedBranches: 消さないブランチ
 * @returns {string[]} 候補のブランチ名。detached HEAD の行は含まない
 * @throws {TechnicalError} git が失敗したとき
 */
function listMergedCandidateBranches({ defaultBranchName, protectedBranches }) {
  const remoteDefaultBranchRef = `origin/${defaultBranchName}`
  // %(refname:short) は、同じ名前のタグがあると `heads/<名前>` と出して、ブランチ名として使えなくなる
  return readGitOutputLines(['branch', '--merged', remoteDefaultBranchRef, '--format=%(refname)'])
    .filter((ref) => ref.startsWith(LOCAL_BRANCH_REF_PREFIX))
    .map((ref) => ref.slice(LOCAL_BRANCH_REF_PREFIX.length))
    .filter((branch) => !protectedBranches.has(branch))
}

/**
 * 消す候補のブランチを、マージ済み PR の作業と確かめられたものに絞る。PR が無い・マージされていない・PR の作業でない
 * ブランチは黙って除く。gh・git が失敗して判定できなかったブランチは、理由を標準エラーに出して除く。
 *
 * @param {{ originUrl: string, defaultBranchName: string, branches: string[] }} params
 *   originUrl: origin の URL / defaultBranchName: PR のマージ先 / branches: 消す候補のブランチ名
 * @returns {{ coveredBranches: string[], uncheckedCount: number }} マージ済み PR の作業と確かめられたブランチと、判定できなかった件数
 */
function selectBranchesCoveredByMergedPullRequest({ originUrl, defaultBranchName, branches }) {
  const coveredBranches = []
  let uncheckedCount = 0
  for (const branch of branches) {
    let isCovered
    try {
      isCovered = isCoveredByMergedPullRequest({ originUrl, defaultBranchName, branch })
    } catch (error) {
      console.error(`残した: ${branch}: PR を確かめられませんでした: ${error.message}`)
      uncheckedCount++
      continue
    }
    if (isCovered) coveredBranches.push(branch)
  }
  return { coveredBranches, uncheckedCount }
}

/**
 * ローカルブランチが、そのブランチ名から出てデフォルトブランチへマージされた PR の作業かを確かめる。
 * 先端が PR の先端と同じかその祖先で、かつマージ直前のデフォルトブランチに含まれていなければ、その PR の作業とみなす。
 *
 * @param {{ originUrl: string, defaultBranchName: string, branch: string }} params
 *   originUrl: origin の URL / defaultBranchName: PR のマージ先 / branch: 確かめるブランチ名
 * @returns {boolean} 当てはまるマージ済み PR があれば true。PR が無い・マージされていない・PR の作業でなければ false
 * @throws {TechnicalError} gh が失敗したとき・PR のコミットが手元に無く判定できなかったとき
 */
function isCoveredByMergedPullRequest({ originUrl, defaultBranchName, branch }) {
  const mergedPullRequests = JSON.parse(
    runCommand('gh', [
      'pr',
      'list',
      '--repo',
      originUrl,
      '--head',
      branch,
      '--base',
      defaultBranchName,
      '--state',
      'merged',
      '--json',
      'headRefOid,mergeCommit'
    ])
  )
  // 作ったばかりのブランチも先端が origin/<デフォルトブランチ> から辿れるので、git の履歴だけではマージ済みと見分けられない。
  // PR はブランチ名で引けるが、名前だけで照合すると、マージ済み PR と同じ名前で作り直したブランチまで消す。
  // PR の先端と同じコミットに限らないのは、PR の先端がローカルより先へ進んでいることが多いため（別の clone で直した・取り込んだ）
  const localTip = `${LOCAL_BRANCH_REF_PREFIX}${branch}`
  return mergedPullRequests.some(
    ({ headRefOid, mergeCommit }) =>
      isAncestorCommit({ ancestor: localTip, descendant: headRefOid }) &&
      // マージ直前のデフォルトブランチに含まれる先端は、PR の作業ではなく古いデフォルトブランチから作り直したもの
      !isAncestorCommit({ ancestor: localTip, descendant: `${mergeCommit.oid}^1` })
  )
}

/**
 * `ancestor` が `descendant` と同じコミットか、その祖先かを確かめる。
 *
 * @param {{ ancestor: string, descendant: string }} params ancestor: 祖先と見込むコミット / descendant: 子孫と見込むコミット
 * @returns {boolean} 同じか祖先なら true
 * @throws {TechnicalError} どちらかのコミットが手元に無いなど、判定できなかったとき
 */
function isAncestorCommit({ ancestor, descendant }) {
  try {
    runGit(['merge-base', '--is-ancestor', ancestor, descendant])
    return true
  } catch (error) {
    // 終了コード 1 だけが「祖先でない」。それ以外（コミットが手元に無いなど）は判定の失敗なので投げる
    if (error.cause?.status === 1) return false
    throw error
  }
}

/**
 * マージ済み PR の作業と確かめたブランチから、消すものを選ぶ。何も消さない。残すブランチは、理由を標準エラーに出す。
 *
 * @param {{ coveredBranches: string[], worktreePathByBranch: Map<string, string>,
 *   sessionWorkingDirectories: string[] | undefined }} params
 *   coveredBranches: マージ済み PR の作業と確かめたブランチ / worktreePathByBranch: ブランチを抱える worktree の場所 /
 *   sessionWorkingDirectories: 生きているセッションの作業ディレクトリ。分からなければ undefined
 * @returns {{ deletionTargets: { branch: string, worktreePath: string | undefined }[], keptCount: number }}
 *   消すブランチ（抱えている worktree の場所つき）と、残した件数
 */
function selectDeletionTargets({
  coveredBranches,
  worktreePathByBranch,
  sessionWorkingDirectories
}) {
  const deletionTargets = []
  let keptCount = 0
  for (const branch of coveredBranches) {
    const worktreePath = worktreePathByBranch.get(branch)
    let keepReason
    try {
      keepReason = findReasonToKeepBranch({ branch, worktreePath, sessionWorkingDirectories })
    } catch (error) {
      keepReason = `git branch -d が通るかを確かめられませんでした: ${error.message}`
    }
    if (keepReason === undefined) {
      deletionTargets.push({ branch, worktreePath })
    } else {
      console.error(`残した: ${branch}: ${keepReason}`)
      keptCount++
    }
  }
  return { deletionTargets, keptCount }
}

/**
 * ブランチを消さずに残す理由を返す。
 *
 * @param {{ branch: string, worktreePath: string | undefined, sessionWorkingDirectories: string[] | undefined }} params
 *   branch: 消す候補 / worktreePath: そのブランチを抱える worktree の場所 /
 *   sessionWorkingDirectories: 生きているセッションの作業ディレクトリ。分からなければ undefined
 * @returns {string | undefined} 残す理由。消してよければ undefined
 * @throws {TechnicalError} git が失敗して判定できなかったとき
 */
function findReasonToKeepBranch({ branch, worktreePath, sessionWorkingDirectories }) {
  if (worktreePath && isWorktreeUsedBySession({ worktreePath, sessionWorkingDirectories })) {
    return `セッションが worktree で作業中か、確かめられません: ${worktreePath}`
  }
  const deleteSafetyReference = readDeleteSafetyReference(branch)
  if (
    !isAncestorCommit({
      ancestor: `${LOCAL_BRANCH_REF_PREFIX}${branch}`,
      descendant: deleteSafetyReference
    })
  ) {
    return `git branch -d が基準にする ${deleteSafetyReference} に取り込まれていないので、-d が拒みます`
  }
  return undefined
}

/**
 * worktree の中で、生きているセッションが作業しているかを返す。
 *
 * @param {{ worktreePath: string, sessionWorkingDirectories: string[] | undefined }} params
 *   worktreePath: 調べる worktree / sessionWorkingDirectories: 生きているセッションの作業ディレクトリ。分からなければ undefined
 * @returns {boolean} 作業しているか、分からなければ true
 */
function isWorktreeUsedBySession({ worktreePath, sessionWorkingDirectories }) {
  if (sessionWorkingDirectories === undefined) return true
  let worktreeRealPath
  try {
    worktreeRealPath = realpathSync(worktreePath)
  } catch {
    worktreeRealPath = worktreePath
  }
  return sessionWorkingDirectories.some(
    (directory) =>
      directory === worktreeRealPath || directory.startsWith(`${worktreeRealPath}${sep}`)
  )
}

/**
 * `git branch -d` が、ブランチを消してよいかの基準にする参照を返す。
 *
 * @param {string} branch ブランチ名
 * @returns {string} ブランチの upstream を指す名前。upstream が無い・消えている（`[gone]`）ときは `HEAD`
 */
function readDeleteSafetyReference(branch) {
  const upstreamRef = `${branch}@{upstream}`
  try {
    runGit(['rev-parse', '--verify', '--quiet', upstreamRef])
    return upstreamRef
  } catch {
    // upstream を引けないとき git は失敗する。-d も、そのときは HEAD を基準にする
    return 'HEAD'
  }
}

/**
 * `--dry-run` のとき、消す予定のブランチを1件1行で出力する。何も消さない。
 *
 * @param {{ branch: string, worktreePath: string | undefined }[]} deletionTargets 消す予定のブランチと、抱えている worktree の場所
 * @returns {void}
 */
function printPlannedDeletions(deletionTargets) {
  for (const { branch, worktreePath } of deletionTargets) {
    console.log(`削除予定: ${branch}${worktreePath ? `（worktree: ${worktreePath}）` : ''}`)
  }
}

/**
 * ブランチを1件ずつ消す。失敗したブランチは、理由を標準エラーに出して残す。
 *
 * @param {{ branch: string, worktreePath: string | undefined }[]} deletionTargets 消すブランチと、抱えている worktree の場所
 * @returns {number} 消せなかった件数
 */
function deleteBranches(deletionTargets) {
  let failedCount = 0
  for (const target of deletionTargets) {
    try {
      deleteBranch(target)
    } catch (error) {
      console.error(`残した: ${target.branch}: ${error.message}`)
      failedCount++
    }
  }
  return failedCount
}

/**
 * 1つのブランチを消す。抱えている worktree があれば先に外す。
 *
 * @param {{ branch: string, worktreePath: string | undefined }} target 消すブランチと、そのブランチを抱える worktree の場所
 * @returns {void}
 * @throws {TechnicalError} worktree を外せない・`-d` が拒否したとき（未コミットの変更など）
 */
function deleteBranch({ branch, worktreePath }) {
  const deletedBranchTipSha = runGit(['rev-parse', `${LOCAL_BRANCH_REF_PREFIX}${branch}`])
  if (worktreePath) {
    runGit(['worktree', 'remove', worktreePath])
    console.log(`worktree を外した: ${worktreePath}`)
  }
  runGit(['branch', '-d', branch])
  console.log(`削除: ${branch}（was ${deletedBranchTipSha}）`)
}

/**
 * git を1回実行し、標準出力の末尾の改行を落として返す。
 *
 * @param {string[]} args git に渡す引数
 * @returns {string} 標準出力
 * @throws {TechnicalError} git が失敗したとき（`runCommand` と同じ）
 */
function runGit(args) {
  return runCommand('git', args)
}

/**
 * git を1回実行し、標準出力を行ごとの配列で返す。
 *
 * @param {string[]} args git に渡す引数
 * @returns {string[]} 標準出力の各行。出力が空なら空配列
 * @throws {TechnicalError} git が失敗したとき（`runCommand` と同じ）
 */
function readGitOutputLines(args) {
  const output = runGit(args)
  return output === '' ? [] : output.split('\n')
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCli()
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
