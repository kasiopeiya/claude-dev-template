#!/usr/bin/env node
// 責務: /html の作業用 HTML から、design-system のフォルダなしで開ける配布用の1枚（`<作業用の名前>-standalone.html`）を
//   同じフォルダに書き出すことだけを担う。埋め込みは scripts/lib/inline-design-system.mjs に任せる。
//
// 設計意図（WHY）:
// - 作業用には埋め込まず、別の1枚を書く。AI は生成後も作業用を直すので、共有 CSS の写しが入ると読み直しが重くなり、
//   写しを直すとデザインシステムがファイルごとに分かれる。配布用は毎回上書きし、直すのは作業用だけにする。
// - 相対パスは、作業用 HTML のあるフォルダを基準に解く。ブラウザで確かめた作業用と同じ見た目にするため。
//   Skill の design-system を直接読むと、作業用の横のコピーと食い違ったときに、確かめた見た目と変わる。
// - 埋め込めないときは、新しい1枚を書かずに終了コード 1 で終える。壊れた1枚を書くと、配った先で崩れて初めて気づくことになるため。
//   前回の配布用は、埋め込む前に消す。残すと、直した作業用と食い違う古い1枚を、それと知らずに配りうる。
// - 相対パスの引数は、打った場所（INIT_CWD）を基準に解く。npm run は cwd をパッケージ直下に変えるため。
//
// 使い方: npm run --silent export-standalone-html -- <作業用 HTML のパス>

import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { BusinessError } from './lib/errors.mjs'
import { inlineLocalStylesAndScripts } from './lib/inline-design-system.mjs'

const STANDALONE_SUFFIX = '-standalone'
const USAGE_MESSAGE =
  '作業用 HTML のパスを1つ渡してください（例: npm run --silent export-standalone-html -- ./20261113-example.html）'

try {
  const standaloneHtmlPath = exportStandaloneHtml(process.argv.slice(2))
  console.log(`配布用の1枚を書き出しました: ${standaloneHtmlPath}`)
} catch (error) {
  console.error(error instanceof BusinessError ? `書き出せません（${error.message}）` : error.stack)
  process.exitCode = 1
}

/**
 * コマンドラインの引数から作業用 HTML を読み、埋め込んだ配布用の1枚を同じフォルダに書き出す。
 *
 * @param {string[]} commandLineArguments `node scripts/export-standalone-html.mjs` の後ろに渡された引数
 * @returns {string} 書き出した配布用の1枚のパス
 * @throws {BusinessError} 引数が不正なとき・作業用 HTML が無いとき・埋め込めないとき
 */
function exportStandaloneHtml(commandLineArguments) {
  const workingHtmlPath = parseWorkingHtmlPath(commandLineArguments)
  const workingHtmlText = readWorkingHtml(workingHtmlPath)
  const standaloneHtmlPath = buildStandaloneHtmlPath(workingHtmlPath)
  rmSync(standaloneHtmlPath, { force: true })
  const standaloneHtmlText = inlineLocalStylesAndScripts({
    htmlText: workingHtmlText,
    baseDirectoryPath: path.dirname(workingHtmlPath)
  })
  writeFileSync(standaloneHtmlPath, standaloneHtmlText)
  return standaloneHtmlPath
}

/**
 * @param {string[]} commandLineArguments コマンドラインの引数
 * @returns {string} 作業用 HTML の絶対パス
 * @throws {BusinessError} パスが1つでないとき・`.html` でないとき・配布用の1枚を渡したとき
 */
function parseWorkingHtmlPath(commandLineArguments) {
  if (commandLineArguments.length !== 1) {
    throw new BusinessError(USAGE_MESSAGE)
  }
  const workingHtmlPath = path.resolve(
    process.env.INIT_CWD ?? process.cwd(),
    commandLineArguments[0]
  )
  if (path.extname(workingHtmlPath).toLowerCase() !== '.html') {
    throw new BusinessError(`.html のファイルを渡してください（${workingHtmlPath}）`)
  }
  if (path.basename(workingHtmlPath, path.extname(workingHtmlPath)).endsWith(STANDALONE_SUFFIX)) {
    throw new BusinessError(
      `配布用の1枚ではなく、作業用の HTML を渡してください（${workingHtmlPath}）`
    )
  }
  return workingHtmlPath
}

/**
 * @param {string} workingHtmlPath 作業用 HTML の絶対パス
 * @returns {string} 作業用 HTML の中身
 * @throws {BusinessError} 作業用 HTML が無いとき
 */
function readWorkingHtml(workingHtmlPath) {
  try {
    return readFileSync(workingHtmlPath, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error
    }
    throw new BusinessError(`作業用 HTML がありません（${workingHtmlPath}）`, { cause: error })
  }
}

/**
 * @param {string} workingHtmlPath 作業用 HTML の絶対パス
 * @returns {string} 同じフォルダの `<作業用の名前>-standalone.html` のパス
 */
function buildStandaloneHtmlPath(workingHtmlPath) {
  const extension = path.extname(workingHtmlPath)
  return path.join(
    path.dirname(workingHtmlPath),
    `${path.basename(workingHtmlPath, extension)}${STANDALONE_SUFFIX}${extension}`
  )
}
