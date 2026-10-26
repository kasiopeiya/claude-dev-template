#!/usr/bin/env node
// 責務: Claude Code のセッション登録ファイルを読み、いまの作業ツリーで生きているセッションの数を数えることのみを担う。
//   /git-commit の「並行セッションを検出する」が、lsof の無い環境（Windows の Git Bash など）でだけ呼ぶ。
//
// 設計意図（WHY）:
// - lsof がある環境では、ps/lsof で OS のプロセスを数える方が取りこぼさない。ここを使うのは lsof が無いときだけ。
//   Windows には他プロセスの cwd を引く標準のコマンドが無く、登録ファイルを読むほかに手が無い（Issue #951）
// - 登録ファイル（<設定ディレクトリ>/sessions/<pid>.json）は Claude Code の非公開の内部ファイルである（読み方は liveClaudeSessions.mjs）。
//   次のセッションは登録ファイルを書かないので数えられない：agent teams の teammate、別の claude から起動した
//   一部の子セッション、登録に失敗したセッション、CLAUDE_CONFIG_DIR を分けて起動したセッション（v2.1.296 で確認）
// - 迷ったら数える（別セッションが居る扱いにする）。数えすぎても不要な worktree を作るだけだが、
//   数え落とすと別セッションの変更をコミットに巻き込む
// - 登録ディレクトリを読めないときは 0 を出す。呼び出し側は 0 を「判定できない＝居る扱い」として扱う
//
// 使い方: npm run -s count-registered-worktree-sessions
//   件数を1行で標準出力に返す。終了コードは常に 0

import { execFileSync } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  listLiveSessionRegistrationFilePaths,
  readRegisteredWorkingDirectory,
  resolveClaudeConfigDirectory
} from './liveClaudeSessions.mjs'
import { TechnicalError } from './lib/errors.mjs'

// git が応答しないときに、検出の手順ごと止めないための上限
const GIT_QUERY_TIMEOUT_MS = 5000
// git が fatal で終わるときの終了コード。git の外・ディレクトリが無いときがこれで、safe.directory の拒否など
// ほかの fatal も同じ 128 になる。区別する手段が無いので、どれも「作業ツリーが無い」として扱う
const GIT_FATAL_EXIT_CODE = 128
// git を起動する作業ディレクトリ。Windows は実行ファイルを PATH より先に作業ディレクトリから探すため、
// 登録ファイルに書かれた cwd ではなく、このスクリプトの置き場所に固定する
const trustedWorkingDirectory = dirname(fileURLToPath(import.meta.url))

/**
 * いまの作業ツリーで生きている、登録済みのセッションを数える。
 *
 * @param {{ configDirectory: string }} params configDirectory: Claude Code の設定ディレクトリ
 * @returns {number} セッションの数。登録ディレクトリを読めない・いまの作業ツリーを引けなければ 0
 */
function countRegisteredWorktreeSessions({ configDirectory }) {
  let ownWorktreeRoot
  let registrationFilePaths
  try {
    ownWorktreeRoot = readWorktreeRoot(process.cwd())
    registrationFilePaths = listLiveSessionRegistrationFilePaths(configDirectory)
  } catch {
    return 0
  }
  if (ownWorktreeRoot === undefined) return 0
  return registrationFilePaths.filter((registrationFilePath) =>
    isSessionInOwnWorktree({ registrationFilePath, ownWorktreeRoot })
  ).length
}

/**
 * 登録されたセッションが、いまの作業ツリーで動いているかを返す。
 *
 * @param {{ registrationFilePath: string, ownWorktreeRoot: string }} params
 *   registrationFilePath: 生きている pid の登録ファイルのパス / ownWorktreeRoot: いまの作業ツリーのルート
 * @returns {boolean} 同じ作業ツリーなら true。cwd を読めないとき・cwd の作業ツリーを git に確かめられなかったとき
 *   （タイムアウトなど）も、数え落とさないよう true。cwd が git の外にある・消えていると分かったときは false
 */
function isSessionInOwnWorktree({ registrationFilePath, ownWorktreeRoot }) {
  const registeredWorkingDirectory = readRegisteredWorkingDirectory(registrationFilePath)
  if (registeredWorkingDirectory === undefined) return true
  let registeredWorktreeRoot
  try {
    registeredWorktreeRoot = readWorktreeRoot(registeredWorkingDirectory)
  } catch {
    return true
  }
  return (
    registeredWorktreeRoot !== undefined &&
    toComparableWorktreeRoot(registeredWorktreeRoot) === toComparableWorktreeRoot(ownWorktreeRoot)
  )
}

/**
 * 指定したディレクトリを含む作業ツリーのルートを返す。
 *
 * @param {string} directory 調べるディレクトリ
 * @returns {string | undefined} 作業ツリーのルート。git の外にある・ディレクトリが無いと分かったときは undefined
 * @throws {TechnicalError} git に確かめられなかったとき（タイムアウト・git を起動できないなど）
 */
function readWorktreeRoot(directory) {
  try {
    return execFileSync('git', ['-C', directory, 'rev-parse', '--show-toplevel'], {
      cwd: trustedWorkingDirectory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: GIT_QUERY_TIMEOUT_MS
    }).trim()
  } catch (error) {
    if (error.status === GIT_FATAL_EXIT_CODE) return undefined
    throw new TechnicalError(`作業ツリーを git に確かめられません: ${directory}`, { cause: error })
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

console.log(
  countRegisteredWorktreeSessions({ configDirectory: resolveClaudeConfigDirectory(process.env) })
)
