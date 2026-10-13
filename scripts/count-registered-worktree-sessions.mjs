#!/usr/bin/env node
// 責務: Claude Code のセッション登録ファイルを読み、いまの作業ツリーで生きているセッションの数を数えることのみを担う。
//   /git-commit の「並行セッションを検出する」が、lsof の無い環境（Windows の Git Bash など）でだけ呼ぶ。
//
// 設計意図（WHY）:
// - lsof がある環境では、ps/lsof で OS のプロセスを数える方が取りこぼさない。ここを使うのは lsof が無いときだけ。
//   Windows には他プロセスの cwd を引く標準のコマンドが無く、登録ファイルを読むほかに手が無い（Issue #951）
// - 登録ファイル（<設定ディレクトリ>/sessions/<pid>.json）は Claude Code の非公開の内部ファイルである。
//   次のセッションは登録ファイルを書かないので数えられない：agent teams の teammate、別の claude から起動した
//   一部の子セッション、登録に失敗したセッション、CLAUDE_CONFIG_DIR を分けて起動したセッション（v2.1.296 で確認）
// - 迷ったら数える（別セッションが居る扱いにする）。数えすぎても不要な worktree を作るだけだが、
//   数え落とすと別セッションの変更をコミットに巻き込む
// - 登録ディレクトリを読めないときは 0 を出す。呼び出し側は 0 を「判定できない＝居る扱い」として扱う
//
// 使い方: npm run -s count-registered-sessions
//   件数を1行で標準出力に返す。終了コードは常に 0

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 登録ファイルの名前。pid は中身ではなく名前から取り、中身が壊れていても生死を確かめられるようにする
const REGISTRATION_FILE_NAME_PATTERN = /^(\d+)\.json$/
// git が応答しないときに、検出の手順ごと止めないための上限
const GIT_QUERY_TIMEOUT_MS = 5000
// git を起動する作業ディレクトリ。Windows は実行ファイルを PATH より先に作業ディレクトリから探すため、
// 登録ファイルに書かれた cwd ではなく、このスクリプトの置き場所に固定する
const trustedWorkingDirectory = dirname(fileURLToPath(import.meta.url))

/**
 * 指定したディレクトリを含む作業ツリーのルートを返す。
 *
 * @param {string} directory 調べるディレクトリ
 * @returns {string | undefined} 作業ツリーのルート。git の外・ディレクトリが消えたなどで引けなければ undefined
 */
function readWorktreeRoot(directory) {
  try {
    return execFileSync('git', ['-C', directory, 'rev-parse', '--show-toplevel'], {
      cwd: trustedWorkingDirectory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_QUERY_TIMEOUT_MS
    }).trim()
  } catch {
    return undefined
  }
}

/**
 * 作業ツリーのルートを、比べられる形にそろえる。Windows はパスの大文字・小文字を区別しないため小文字にする。
 *
 * @param {string} worktreeRoot `git rev-parse --show-toplevel` の出力
 * @returns {string} 比べるためのパス
 */
function toComparableWorktreeRoot(worktreeRoot) {
  return process.platform === 'win32' ? worktreeRoot.toLowerCase() : worktreeRoot
}

/**
 * プロセスが生きているかを返す。
 *
 * @param {number} pid 調べるプロセスの pid
 * @returns {boolean} 生きていれば true。シグナルを送る権限が無いだけ（EPERM）のときも、存在はするので true
 */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/**
 * 登録ファイルから、そのセッションの作業ディレクトリを読む。
 *
 * @param {string} registrationFilePath 登録ファイルのパス
 * @returns {string | undefined} 作業ディレクトリ。読めない・JSON が壊れている・cwd が無ければ undefined
 */
function readRegisteredWorkingDirectory(registrationFilePath) {
  try {
    const { cwd } = JSON.parse(readFileSync(registrationFilePath, 'utf8'))
    return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
  } catch {
    return undefined
  }
}

/**
 * 登録されたセッションが、いまの作業ツリーで動いているかを返す。
 *
 * @param {{ registrationFilePath: string, ownWorktreeRoot: string }} params
 *   registrationFilePath: 生きている pid の登録ファイルのパス / ownWorktreeRoot: いまの作業ツリーのルート
 * @returns {boolean} 同じ作業ツリーなら true。cwd を読めないときも、数え落とさないよう true
 */
function isSessionInOwnWorktree({ registrationFilePath, ownWorktreeRoot }) {
  const registeredWorkingDirectory = readRegisteredWorkingDirectory(registrationFilePath)
  if (registeredWorkingDirectory === undefined) return true
  const registeredWorktreeRoot = readWorktreeRoot(registeredWorkingDirectory)
  return (
    registeredWorktreeRoot !== undefined &&
    toComparableWorktreeRoot(registeredWorktreeRoot) === toComparableWorktreeRoot(ownWorktreeRoot)
  )
}

/**
 * いまの作業ツリーで生きている、登録済みのセッションを数える。
 *
 * @returns {number} セッションの数。登録ディレクトリを読めない・いまの作業ツリーを引けなければ 0
 */
function countRegisteredWorktreeSessions() {
  const ownWorktreeRoot = readWorktreeRoot(process.cwd())
  if (ownWorktreeRoot === undefined) return 0
  const configDirectory = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  const registrationDirectory = join(configDirectory, 'sessions')
  let registrationFileNames
  try {
    registrationFileNames = readdirSync(registrationDirectory)
  } catch {
    return 0
  }
  return registrationFileNames.filter((fileName) => {
    const pidMatch = REGISTRATION_FILE_NAME_PATTERN.exec(fileName)
    if (pidMatch === null || !isProcessAlive(Number(pidMatch[1]))) return false
    const registrationFilePath = join(registrationDirectory, fileName)
    return isSessionInOwnWorktree({ registrationFilePath, ownWorktreeRoot })
  }).length
}

console.log(countRegisteredWorktreeSessions())
