// 責務: 生きている Claude Code セッションを、登録ファイルと会話ログから引くことのみを担う。
//
// 設計意図（WHY）:
// - 登録ファイル（<設定ディレクトリ>/sessions/<pid>.json）と会話ログ（<設定ディレクトリ>/projects/<プロジェクト>/<sessionId>.jsonl）は
//   Claude Code の非公開の内部ファイルで、形式は Claude Code の更新で変わりうる。読み方をここに集め、直す場所を1つにする
// - 登録ファイルの pid は、中身ではなくファイル名から取る。中身が壊れていても生死を確かめられるようにするため
// - 設定ディレクトリは呼び出し側が決めて渡す。環境変数は入口で1回だけ読む（configuration-policy）

import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { TechnicalError } from './lib/errors.mjs'
import { isProcessAlive } from './processLiveness.mjs'

const REGISTRATION_FILE_NAME_PATTERN = /^(\d+)\.json$/
// 会話ログの末尾から読む量。cwd は各行に入っているので、直近の数行が入れば足りる
const TRANSCRIPT_TAIL_BYTES = 1024 * 1024

/**
 * Claude Code の設定ディレクトリを決める。
 *
 * @param {Record<string, string | undefined>} env 環境変数
 * @returns {string} `CLAUDE_CONFIG_DIR`。無い・空文字のときは `~/.claude`
 */
export function resolveClaudeConfigDirectory(env) {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

/**
 * pid が生きているセッションの登録ファイルのパスを集める。pid が死んだセッションの登録ファイルは除く。
 *
 * @param {string} configDirectory Claude Code の設定ディレクトリ
 * @returns {string[]} 登録ファイルのパス
 * @throws {Error} 登録ディレクトリ（`<設定ディレクトリ>/sessions`）を読めないとき
 */
export function listLiveSessionRegistrationFilePaths(configDirectory) {
  const registrationDirectory = join(configDirectory, 'sessions')
  return readdirSync(registrationDirectory).flatMap((fileName) => {
    const pidMatch = REGISTRATION_FILE_NAME_PATTERN.exec(fileName)
    if (pidMatch === null || !isProcessAlive(Number(pidMatch[1]))) return []
    return [join(registrationDirectory, fileName)]
  })
}

/**
 * 生きている Claude Code セッションそれぞれの、いまの作業ディレクトリを集める。
 * 会話ログの最後に記録された cwd を使い、会話ログがまだ無いセッションは登録ファイルの cwd（起動したフォルダ）を使う。
 *
 * @param {string} configDirectory Claude Code の設定ディレクトリ
 * @returns {string[]} 作業ディレクトリ
 * @throws {TechnicalError} 登録ファイルを読めない・sessionId か cwd が無い・会話ログの末尾に cwd を持つ行が無いとき
 * @throws {Error} 会話ログのディレクトリ・ファイルを読めないとき（fs のエラーをそのまま通す）
 */
export function readLiveSessionWorkingDirectories(configDirectory) {
  const projectsDirectory = join(configDirectory, 'projects')
  return listLiveSessionRegistrationFilePaths(configDirectory).map((registrationFilePath) => {
    const { sessionId, cwd } = readSessionRegistration(registrationFilePath)
    return readLastTranscriptWorkingDirectory({ projectsDirectory, sessionId }) ?? cwd
  })
}

/**
 * 登録ファイルから、そのセッションの起動したフォルダを読む。
 *
 * @param {string} registrationFilePath 登録ファイルのパス
 * @returns {string | undefined} 起動したフォルダ。読めない・JSON が壊れている・cwd が無い・空文字なら undefined
 */
export function readRegisteredWorkingDirectory(registrationFilePath) {
  try {
    return parseSessionRegistration(registrationFilePath).cwd
  } catch {
    return undefined
  }
}

/**
 * 登録ファイルから、セッションの ID と起動したフォルダを読む。
 *
 * @param {string} registrationFilePath 登録ファイルのパス
 * @returns {{ sessionId: string, cwd: string }} セッションの ID と、登録時の作業ディレクトリ
 * @throws {TechnicalError} 読めない・JSON が壊れている・sessionId か cwd が無い（文字列でない・cwd が空文字）とき。メッセージはファイルのパスを含む
 */
function readSessionRegistration(registrationFilePath) {
  let registration
  try {
    registration = parseSessionRegistration(registrationFilePath)
  } catch (error) {
    throw new TechnicalError(
      `登録ファイルを読めません: ${registrationFilePath}: ${error.message}`,
      {
        cause: error
      }
    )
  }
  const { sessionId, cwd } = registration
  if (sessionId === undefined || cwd === undefined) {
    throw new TechnicalError(
      `登録ファイルに sessionId か cwd がありません: ${registrationFilePath}`
    )
  }
  return { sessionId, cwd }
}

/**
 * 登録ファイルを読み、セッションの ID と起動したフォルダを取り出す。
 *
 * @param {string} registrationFilePath 登録ファイルのパス
 * @returns {{ sessionId: string | undefined, cwd: string | undefined }}
 *   セッションの ID と登録時の作業ディレクトリ。無い・文字列でない・cwd が空文字のものは undefined
 * @throws {Error} 読めない・JSON が壊れているとき
 */
function parseSessionRegistration(registrationFilePath) {
  const { sessionId, cwd } = JSON.parse(readFileSync(registrationFilePath, 'utf8')) ?? {}
  return {
    sessionId: typeof sessionId === 'string' ? sessionId : undefined,
    cwd: typeof cwd === 'string' && cwd !== '' ? cwd : undefined
  }
}

/**
 * セッションの会話ログから、最後に記録された作業ディレクトリを読む。
 *
 * @param {{ projectsDirectory: string, sessionId: string }} params
 *   projectsDirectory: 会話ログを置く `<設定ディレクトリ>/projects` / sessionId: 調べるセッションの ID
 * @returns {string | undefined} 作業ディレクトリ。会話ログがまだ無ければ undefined
 * @throws {TechnicalError} 会話ログの末尾に cwd を持つ行が無いとき
 */
function readLastTranscriptWorkingDirectory({ projectsDirectory, sessionId }) {
  const transcriptPath = readdirSync(projectsDirectory)
    .map((projectName) => join(projectsDirectory, projectName, `${sessionId}.jsonl`))
    .find((path) => existsSync(path))
  if (transcriptPath === undefined) return undefined
  const lines = readFileTail(transcriptPath, TRANSCRIPT_TAIL_BYTES).split('\n').reverse()
  for (const line of lines) {
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue // 途中から読んだ先頭の行と、書きかけの行
    }
    if (typeof entry?.cwd === 'string' && entry.cwd !== '') return entry.cwd
  }
  throw new TechnicalError(`会話ログの末尾に cwd がありません: ${transcriptPath}`)
}

/**
 * ファイルの末尾を読む。
 *
 * @param {string} path 読むファイル
 * @param {number} byteCount 末尾から読むバイト数の上限
 * @returns {string} 読んだ内容。先頭は行の途中から始まりうる
 */
function readFileTail(path, byteCount) {
  const fileDescriptor = openSync(path, 'r')
  try {
    const { size } = fstatSync(fileDescriptor)
    const length = Math.min(size, byteCount)
    const buffer = Buffer.alloc(length)
    readSync(fileDescriptor, buffer, 0, length, size - length)
    return buffer.toString('utf8')
  } finally {
    closeSync(fileDescriptor)
  }
}
