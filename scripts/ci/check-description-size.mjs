#!/usr/bin/env node
// 責務: Skill・agent の frontmatter の `description`（と `when_to_use`）が文字数上限に収まっているかを検査する。
//   上限の値はこのファイルの TOTAL_CHARACTER_LIMIT（合計）と PER_ENTRY_CHARACTER_LIMIT（1件）が正典。
//   ポリシー・Rule に具体値を書くと、値を変えるたびに複数箇所を直すことになるので、ここ以外に書かない。
//   description は一覧として毎セッション読み込まれるため、文字数がそのまま毎回のコンテキスト消費になる。
//
// 設計意図（WHY）:
// - 上限は合計と1件の2本。1件の上限だけでは件数の増加を止められず、合計だけでは1件の肥大を止められない。
// - 数えるのは、一覧に載る Skill（`disable-model-invocation: true` を除く）と全 agent。
//   一覧に載らない Skill の description は毎回は読まれない。
// - Claude Code は `description` と `when_to_use` を合わせて一覧に載せるので、合算して数える。
//   分けて数えると、`when_to_use` が上限の抜け道になる。
// - frontmatter の読み方は、1行で書いた値だけに対応する。複数行の書き方（`>`・`|`・折り返し・
//   値を次の行から書く形）は、黙って短く数えると検査をすり抜けるため、対応外として落とす。
//
// 判定ロジックはこのファイル1ヶ所にしか置かない。ターン末ゲートと CI の2経路から呼ばれる。

import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

import { countCharacters } from './count-characters.mjs'
import { listWorkingTreeFiles } from './list-working-tree-files.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')

const TOTAL_CHARACTER_LIMIT = 6000
const PER_ENTRY_CHARACTER_LIMIT = 200

const SKILL_PATH_PATTERN = /^\.claude\/skills\/[^/]+\/SKILL\.md$/
const AGENT_PATH_PATTERN = /^\.claude\/agents\/.+\.md$/

// 合計の超過を報告するとき、削る候補として長い順に示す件数
const LONGEST_ENTRY_REPORT_COUNT = 5

function main() {
  const judgement = judgeLimits(listDescriptionFilePaths().map(readEntry))

  if (judgement.hasViolation) {
    console.error(formatViolations(judgement))
    process.exit(1)
  }

  console.log(formatSummary(judgement))
}

/**
 * 測った結果を、合計と1件の2本の上限に照らす。
 *
 * @param {ReturnType<typeof readEntry>[]} readings ファイルごとに測った結果
 * @returns {{ unreadableEntries: { path: string, reason: string }[], countedEntries: { path: string, characters: number }[], overLimitEntries: { path: string, characters: number }[], totalCharacters: number, isTotalOverLimit: boolean, hasViolation: boolean }} 判定の内訳
 */
function judgeLimits(readings) {
  const unreadableEntries = readings.filter(({ status }) => status === 'unreadable')
  const countedEntries = readings.filter(({ status }) => status === 'counted')
  const totalCharacters = countedEntries.reduce((sum, { characters }) => sum + characters, 0)
  const overLimitEntries = countedEntries.filter(
    ({ characters }) => characters > PER_ENTRY_CHARACTER_LIMIT
  )
  const isTotalOverLimit = totalCharacters > TOTAL_CHARACTER_LIMIT
  const hasViolation =
    unreadableEntries.length > 0 || overLimitEntries.length > 0 || isTotalOverLimit

  return {
    unreadableEntries,
    countedEntries,
    overLimitEntries,
    totalCharacters,
    isTotalOverLimit,
    hasViolation
  }
}

/**
 * description を検査する対象のファイルを列挙する（Skill の `SKILL.md` と、全 agent の定義）。
 *
 * @returns {string[]} リポジトリ相対パス
 */
function listDescriptionFilePaths() {
  // git の pathspec の `*` は `/` もまたぐため、pathspec だけでは Skill の深い階層の SKILL.md も拾う。
  // agent は `.claude/agents/<名前>/<名前>.md` と入れ子で置くので、配下の .md をすべて残す
  return listWorkingTreeFiles(repoRoot, [
    '.claude/skills/*/SKILL.md',
    '.claude/agents/*.md'
  ]).filter(
    (relativePath) => SKILL_PATH_PATTERN.test(relativePath) || AGENT_PATH_PATTERN.test(relativePath)
  )
}

/**
 * 1ファイルの `description` と `when_to_use` を合わせた文字数を測る（囲む引用符は除く）。
 * 一覧に載らない Skill は数えず skipped を返す。数えられない書き方は unreadable を返す。
 *
 * @param {string} relativePath 測る対象のリポジトリ相対パス
 * @returns {{ status: 'counted', path: string, characters: number } | { status: 'skipped' } | { status: 'unreadable', path: string, reason: string }} 測った結果
 */
function readEntry(relativePath) {
  const frontmatterText = extractFrontmatterText(readFileSync(join(repoRoot, relativePath), 'utf8'))
  if (frontmatterText === null) {
    return { status: 'unreadable', path: relativePath, reason: 'frontmatter が無い' }
  }
  if (isHiddenSkill(relativePath, frontmatterText)) return { status: 'skipped' }

  const descriptionText = readScalar(frontmatterText, 'description')
  const whenToUseText = readScalar(frontmatterText, 'when_to_use')
  const unreadableReason = findUnreadableReason(descriptionText, whenToUseText)
  if (unreadableReason !== null) {
    return { status: 'unreadable', path: relativePath, reason: unreadableReason }
  }

  return {
    status: 'counted',
    path: relativePath,
    characters:
      countCharacters(unquote(descriptionText)) + countCharacters(unquote(whenToUseText ?? ''))
  }
}

/**
 * Skill が一覧に載らない（`disable-model-invocation: true`）かを返す。agent は常に一覧に載る。
 *
 * @param {string} relativePath 対象のリポジトリ相対パス
 * @param {string} frontmatterText frontmatter の中身
 * @returns {boolean} 一覧に載らない Skill なら true
 */
function isHiddenSkill(relativePath, frontmatterText) {
  return (
    SKILL_PATH_PATTERN.test(relativePath) &&
    readScalar(frontmatterText, 'disable-model-invocation') === 'true'
  )
}

/**
 * 数えられない書き方になっていれば、その理由を返す。数えられるなら null。
 *
 * @param {string | undefined} descriptionText `description` の値（無ければ undefined）
 * @param {string | undefined} whenToUseText `when_to_use` の値（無ければ undefined）
 * @returns {string | null} 数えられない理由
 */
function findUnreadableReason(descriptionText, whenToUseText) {
  if (descriptionText === undefined) return '`description` が無い'
  if (descriptionText === '') return '`description` の値が空'
  if (!isSingleLineText(descriptionText)) return '`description` を複数行で書いている（1行で書く）'
  if (whenToUseText === '') return '`when_to_use` の値が空'
  if (whenToUseText !== undefined && !isSingleLineText(whenToUseText)) {
    return '`when_to_use` を複数行で書いている（1行で書く）'
  }
  return null
}

/**
 * 先頭の frontmatter（`---` に挟まれた内側）を取り出す。無ければ null。
 *
 * @param {string} fileText ファイルの全文
 * @returns {string | null} frontmatter の中身
 */
function extractFrontmatterText(fileText) {
  const match = fileText.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  return match ? match[1] : null
}

/**
 * frontmatter の最上位のキーの値（`key:` の右側）を返す。キーが無ければ undefined。
 * 字下げした続きの行は値に含める（改行つきで返す）。続きを落とすと、折り返した値を短く数えてしまう。
 *
 * @param {string} frontmatterText frontmatter の中身
 * @param {string} key 読むキー名（正規表現の記号を含まない）
 * @returns {string | undefined} 末尾の空白を除いた値の文字列
 */
function readScalar(frontmatterText, key) {
  const match = frontmatterText.match(
    new RegExp(`^${key}:[ \\t]*(.*(?:\\r?\\n[ \\t]+\\S.*)*)`, 'm')
  )
  return match ? match[1].trimEnd() : undefined
}

/**
 * 値が1行で書かれていて、そのまま数えられるかを返す（`>`・`|` で始まる書き方と、複数行は対応外）。
 *
 * @param {string} rawText `readScalar` が返した値
 * @returns {boolean} 数えられるなら true
 */
function isSingleLineText(rawText) {
  return !/^[>|]/.test(rawText) && !rawText.includes('\n')
}

/**
 * 値を囲む引用符（シングル・ダブル）を1組だけ除く。
 *
 * @param {string} rawText 値の文字列
 * @returns {string} 引用符を除いた文字列
 */
function unquote(rawText) {
  const isQuoted =
    rawText.length >= 2 &&
    (rawText.startsWith("'") || rawText.startsWith('"')) &&
    rawText.endsWith(rawText[0])
  return isQuoted ? rawText.slice(1, -1) : rawText
}

/**
 * 文字数の多い順に並べた新しい配列を返す。
 *
 * @param {{ characters: number }[]} entries 数えた結果
 * @returns {{ characters: number }[]} 多い順の配列
 */
function sortLongestFirst(entries) {
  return [...entries].sort((first, second) => second.characters - first.characters)
}

/**
 * 合格したときの1行の報告を作る。
 *
 * @param {{ countedEntries: { characters: number }[], totalCharacters: number }} judgement `judgeLimits` の結果
 * @returns {string} 報告文
 */
function formatSummary({ countedEntries, totalCharacters }) {
  const longestCharacters = sortLongestFirst(countedEntries)[0]?.characters ?? 0
  return (
    `Skill・agent の description: 合計 ${totalCharacters} / ${TOTAL_CHARACTER_LIMIT} 文字` +
    `（${countedEntries.length} 件、最長 ${longestCharacters} / ${PER_ENTRY_CHARACTER_LIMIT} 文字）`
  )
}

/**
 * 違反を人間と AI の両方が読める文章にする。直し方（本文へ移す → 人間専用に隠す → 人間に問う）まで書く。
 *
 * @param {ReturnType<typeof judgeLimits>} judgement `judgeLimits` の結果
 * @returns {string} 報告文
 */
function formatViolations({
  unreadableEntries,
  countedEntries,
  overLimitEntries,
  totalCharacters,
  isTotalOverLimit
}) {
  const lines = ['Skill・agent の description が検査に通りません。']

  for (const { path, reason } of unreadableEntries) {
    lines.push(`  ${path}: 読めません（${reason}）`)
  }

  if (isTotalOverLimit) {
    lines.push(
      `  合計: ${totalCharacters} / ${TOTAL_CHARACTER_LIMIT} 文字（超過 ${totalCharacters - TOTAL_CHARACTER_LIMIT}）`,
      '  長い順:',
      ...sortLongestFirst(countedEntries)
        .slice(0, LONGEST_ENTRY_REPORT_COUNT)
        .map(({ path, characters }) => `    ${path}: ${characters} 文字`)
    )
  }

  for (const { path, characters } of overLimitEntries) {
    lines.push(
      `  ${path}: ${characters} / ${PER_ENTRY_CHARACTER_LIMIT} 文字（超過 ${characters - PER_ENTRY_CHARACTER_LIMIT}）`
    )
  }

  lines.push(
    '',
    '直し方（上から順に試す）:',
    '  1. 判別に要らない内容（手順・例・背景）を description から SKILL.md や agent の本文へ移す。',
    '     description には「いつ使うか」を決めるのに要る分だけを残す。',
    '  2. 人間が打つだけの Skill で、他の Skill・agent・文書から名指しで呼ばれていないものは、',
    '     frontmatter に `disable-model-invocation: true` を付ける（一覧に載らなくなる）。',
    '     名指しで呼ばれているかは grep で確かめる。呼ばれている Skill に付けると、その呼び出しが壊れる。',
    '  3. それでも超えるなら、自分で選んで消さず、どの Skill・agent を消すかを人間に問う。'
  )

  return lines.join('\n')
}

main()
