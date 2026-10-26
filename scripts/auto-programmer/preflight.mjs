// 責務: AI 専用 clone で実装を始められる状態を、初回でも手作業なしで整える。
//
// 設計意図（WHY）:
// - clone・依存のインストール・`gh` 認証の確認はすべて機械で実行できる。runbook-policy が
//   「自動化できるものに手順書は要らない」と定めるため、手順書ではなくこのコードが手順そのものになる。
// - ただし `gh auth login` と `claude` の導入は人間の操作が要るので自動化できない。ここでは促して止まる。
// - 対象リポジトリのラベルも、確かめるだけで作らない。作るのはリポジトリの設定を変える操作で、利用先が色や説明を
//   決めて作る（scripts/setup-labels.sh）。無ければ作り方を示して止まる。
// - どの検査も、カードを「着手中」へ動かす前に済ませる。動かした後に落ちると、人間が手でカードを戻す
//   ことになるからである。

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { TechnicalError } from '../lib/errors.mjs'
import { config } from './config.mjs'
import { NEEDS_HUMAN_CHECK_LABEL } from './needsHumanCheck.mjs'
import { runCapture, runJson, runOrThrow, runStreaming } from './shell.mjs'
import { relayChildProcessOutput, showInfo, showSuccess } from './ui.mjs'
import { formatElapsedTime } from './uiFormat.mjs'

// npm のロックファイル名。これを持つディレクトリごとに依存を入れる
const LOCK_FILE_NAME = 'package-lock.json'

// npm ci が成功した後にだけ node_modules の中へ置く印。npm ci は既存 node_modules の中身を消してから
// 入れるので、途中で落ちると node_modules だけが新しい mtime で残る。ディレクトリではなく印の mtime と比べる
const INSTALL_STAMP_FILE_NAME = '.auto-programmer-installed'

const LABEL_SEARCH_LIMIT = 100

/**
 * AI 専用 clone の依存を、ロックファイルを持つディレクトリごとにロックファイルどおり入れる。
 * 入っていて最新のディレクトリは飛ばす。
 *
 * @param {string} workspaceDir このプロセスが使う AI 専用 clone
 * @returns {void}
 * @throws {TechnicalError} clone 内の `git ls-files` が失敗したとき・`npm ci` が 0 以外で終わったとき
 * @throws {Error} `npm` を起動できないとき
 */
export function ensureDependencies(workspaceDir) {
  for (const relativePackageDirectory of listPackageLockDirectories(workspaceDir)) {
    const packageDirectory = join(workspaceDir, relativePackageDirectory)
    if (!needsDependencyInstall(packageDirectory)) continue

    // 取り込むと終わるまで何も出ず止まって見えるので、始まりの行は先に出す
    showInfo(`AI 専用 clone に依存をインストールします: ${relativePackageDirectory}`)
    const startedAt = Date.now()
    // 出力は取り込み、失敗したときだけ出す。成功時の funding・audit の行は、画面の半分以上を埋めて
    // 要る情報を探しにくくする（Issue #848）
    const { exitCode, stdout, stderr } = runCapture('npm', ['ci'], { cwd: packageDirectory })
    if (exitCode !== 0) {
      relayChildProcessOutput('stdout', Buffer.from(stdout))
      relayChildProcessOutput('stderr', Buffer.from(stderr))
      throw new TechnicalError(`npm ci に失敗しました: ${relativePackageDirectory}`)
    }
    // 依存が0件のロックファイルでは npm ci が成功しても node_modules ができず、印の書き込みが ENOENT で落ちる
    const installStampPath = buildInstallStampPath(packageDirectory)
    mkdirSync(dirname(installStampPath), { recursive: true })
    writeFileSync(installStampPath, '')
    showSuccess(
      `依存をインストール  ${relativePackageDirectory}  ${formatElapsedTime(Date.now() - startedAt)}`
    )
  }
}

/**
 * Issue を選ぶ前に済ませられる準備を整える。依存は clone をデフォルトブランチへ戻した後でないと
 * 判定できないため、ここには含めず ensureDependencies で別に行う。
 *
 * @param {string} workspaceDir このプロセスが使う AI 専用 clone
 * @returns {void}
 * @throws {TechnicalError} 人間が済ませるべき準備が無いとき・clone に失敗したとき・既存 clone の origin が config.repository と違うとき・対象リポジトリに needs-human-check ラベルが無いとき
 */
export function runPreflight(workspaceDir) {
  ensureHumanPrerequisites()
  ensureWorkspaceClone(workspaceDir)
  ensureNeedsHumanCheckLabel(workspaceDir)
}

/**
 * `gh auth status` が失敗したときに人間へ見せる文を作る。
 *
 * 原因は未ログインとは限らない（古い gh が `--active` を知らない・通信できないなど）ので、gh の stderr を添える。
 *
 * @param {string} ghStderr `gh auth status` の標準エラー出力
 * @returns {string} 失敗したことと未ログインのときの直し方に、stderr（空なら省く）を続けた文
 */
function buildGhAuthFailureMessage(ghStderr) {
  const summary =
    '`gh auth status` が失敗しました（未ログインなら `gh auth login` を実行してから、もう一度打ってください）'
  const trimmedStderr = ghStderr.trim()
  return trimmedStderr === '' ? summary : `${summary}\n${trimmedStderr}`
}

/**
 * 人間が入れておくべきコマンドが使えるかを確かめる。
 *
 * @returns {void}
 * @throws {TechnicalError} `gh` が起動できない・`gh auth status` が失敗したとき、または `claude` が起動できないとき
 */
function ensureHumanPrerequisites() {
  let ghAuthResult
  try {
    // 対象を絞らないと、別ホスト・別アカウントのトークン切れでも失敗扱いになる
    ghAuthResult = runCapture('gh', ['auth', 'status', '--hostname', 'github.com', '--active'])
  } catch (error) {
    throw new TechnicalError(
      'gh コマンドを起動できません。GitHub CLI を入れてから、もう一度打ってください',
      {
        cause: error
      }
    )
  }
  if (ghAuthResult.exitCode !== 0) {
    throw new TechnicalError(buildGhAuthFailureMessage(ghAuthResult.stderr))
  }
  try {
    runCapture('claude', ['--version'])
  } catch (error) {
    throw new TechnicalError(
      'claude コマンドを起動できません。Claude Code を入れてから、もう一度打ってください',
      { cause: error }
    )
  }
}

/**
 * 対象リポジトリに `needs-human-check` ラベルがあるかを確かめる。
 *
 * 無いと、`/auto-dev` の前に前回の印を外す `gh issue edit --remove-label` が Issue ごとに落ち、止まった印も付けられない。
 * Issue を拾う前に止め、作り方を示す。
 *
 * @param {string} workspaceDir このプロセスが使う AI 専用 clone（作り方の案内に出す）
 * @returns {void}
 * @throws {TechnicalError} ラベルが無いとき・gh が失敗したとき
 */
function ensureNeedsHumanCheckLabel(workspaceDir) {
  const labels = runJson('gh', [
    'label',
    'list',
    '--repo',
    config.repository,
    '--search',
    NEEDS_HUMAN_CHECK_LABEL,
    '--limit',
    String(LABEL_SEARCH_LIMIT),
    '--json',
    'name'
  ])
  // GitHub のラベル名は大文字小文字を区別しない
  const hasLabel = labels.some(
    ({ name }) => name.toLowerCase() === NEEDS_HUMAN_CHECK_LABEL.toLowerCase()
  )
  if (!hasLabel) {
    throw new TechnicalError(
      `${config.repository} に ${NEEDS_HUMAN_CHECK_LABEL} ラベルがありません。` +
        `${workspaceDir} で ./scripts/setup-labels.sh を流すか、` +
        `gh label create ${NEEDS_HUMAN_CHECK_LABEL} --repo ${config.repository} を打ってから、もう一度打ってください`
    )
  }
}

/**
 * git の remote URL から owner/repo を取り出す。HTTPS・`git@host:owner/repo`・`ssh://` のどれでもよい。
 *
 * @param {string} remoteUrl `git remote get-url` の出力
 * @returns {string | null} 小文字の owner/repo（取り出せなければ null）
 */
function readRepositoryFromRemoteUrl(remoteUrl) {
  return (
    remoteUrl
      .trim()
      .match(/[/:]([^/:]+\/[^/]+?)(?:\.git)?\/?$/)?.[1]
      .toLowerCase() ?? null
  )
}

/**
 * AI 専用 clone を用意する。すでにあれば、向き先が設定どおりかだけを確かめる。
 *
 * @param {string} workspaceDir このプロセスが使う AI 専用 clone
 * @returns {void}
 * @throws {TechnicalError} clone に失敗したとき・既存 clone の向き先が config.repository と違うとき
 */
function ensureWorkspaceClone(workspaceDir) {
  if (existsSync(join(workspaceDir, '.git'))) {
    // repository だけを書き換えて古い clone を使い続けると、ボードは新リポジトリ・push は旧リポジトリに割れる
    const originUrl = runOrThrow('git', ['remote', 'get-url', 'origin'], {
      cwd: workspaceDir
    }).trim()
    if (readRepositoryFromRemoteUrl(originUrl) !== config.repository.toLowerCase()) {
      // 2番以降の clone は名前の後ろに -<番号> を付けるので、名前が -<数字> で終わる別のリポジトリの clone と重なりうる
      throw new TechnicalError(
        `${workspaceDir} の origin（${originUrl}）が ${config.repository} ではありません。` +
          '名前が -<数字> で終わる別のリポジトリの clone と重なったときは、AUTO_PROGRAMMER_HOME をリポジトリごとに分けてください'
      )
    }
    return
  }

  showInfo(`AI 専用 clone を作成します: ${workspaceDir}`)
  mkdirSync(dirname(workspaceDir), { recursive: true })
  const { exitCode } = runStreaming('gh', ['repo', 'clone', config.repository, workspaceDir])
  if (exitCode !== 0) throw new TechnicalError(`clone に失敗しました: ${config.repository}`)
}

/**
 * clone 内でロックファイルを持つディレクトリを列挙する。
 *
 * 固定リストにしないのは、ロックファイルが増えたときの直し忘れを防ぐためである。
 *
 * @param {string} workspaceDir このプロセスが使う AI 専用 clone
 * @returns {string[]} clone 直下からの相対パス（直下は `.`）
 * @throws {TechnicalError} `git ls-files` に失敗したとき
 */
function listPackageLockDirectories(workspaceDir) {
  // pathspec の `*` は `/` もまたぐので、入れ子のロックファイルも拾える。
  // -z を付けないと、日本語などを含むパスがクォート付きで出力されて使えない
  const trackedPaths = runOrThrow('git', ['ls-files', '-z', '--', `*${LOCK_FILE_NAME}`], {
    cwd: workspaceDir
  })
    .split('\0')
    .filter(Boolean)
  return trackedPaths.filter((path) => basename(path) === LOCK_FILE_NAME).map(dirname)
}

/**
 * 成功した npm ci の印のパスを返す。印を読む側と書く側が同じ場所を指すよう、ここだけで組み立てる。
 *
 * @param {string} packageDirectory ロックファイルを持つディレクトリ（絶対パス）
 * @returns {string} 印のパス
 */
function buildInstallStampPath(packageDirectory) {
  return join(packageDirectory, 'node_modules', INSTALL_STAMP_FILE_NAME)
}

/**
 * 依存を入れ直す必要があるかを判定する。
 *
 * clone は毎回デフォルトブランチまで戻されるので、そちらで依存が変わるとロックファイルだけが新しくなる。
 *
 * @param {string} packageDirectory 判定するディレクトリ（絶対パス）。ロックファイルを持つこと
 * @returns {boolean} 成功した npm ci の印が無いか、印がロックファイルより古ければ true
 */
function needsDependencyInstall(packageDirectory) {
  const stampPath = buildInstallStampPath(packageDirectory)
  if (!existsSync(stampPath)) return true
  return statSync(join(packageDirectory, LOCK_FILE_NAME)).mtimeMs > statSync(stampPath).mtimeMs
}
