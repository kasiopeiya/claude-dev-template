#!/usr/bin/env node
// 責務: リポジトリ内の各 CLAUDE.md が文字数上限に収まっているかを検査する。
//   上限と「超えたらどうするか」は docs/policy/policy-driven-development-policy.md が正典で、
//   ここはその判定だけを担う。CLAUDE.md は毎セッション全文が読まれるため、文字数がそのまま
//   恒久的なコンテキスト消費になる（Issue #247）。
//
// 判定ロジックはこのファイル1ヶ所にしか置かない。PostToolUse hook と CI の2経路から呼ばれる。

import { existsSync, readFileSync, statSync } from 'fs'
import { execFileSync } from 'child_process'
import { dirname, join, resolve, relative } from 'path'
import { fileURLToPath } from 'url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

export const CHARACTER_LIMIT = 6000

// Claude Code が自動ロードする import 記法（行頭または空白の直後の @パス）。
// メールアドレス・装飾記号を拾わないよう、直前が行頭か空白のものだけを対象にする。
const IMPORT_PATTERN = /(?:^|\s)@([^\s`)\]]+)/g

/**
 * `wc -m` と同じ数え方で文字数を返す（コードポイント単位。UTF-16 の符号単位ではない）。
 *
 * @param {string} text 数える対象の全文
 * @returns {number} 文字数
 */
function countCharacters(text) {
  return [...text].length
}

/**
 * 本文から `@` 記法の import 先を取り出す。
 *
 * コードフェンス内とインラインコードは、記法の説明であって import ではないので落とす。
 *
 * @param {string} source ファイル全文
 * @returns {string[]} import 先として書かれた文字列
 */
function extractImportTargets(source) {
  const targets = []
  let insideFence = false

  for (const line of source.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      insideFence = !insideFence
      continue
    }
    if (insideFence) continue

    const withoutInlineCode = line.replace(/`+[^`]*`+/g, '')
    for (const match of withoutInlineCode.matchAll(IMPORT_PATTERN)) {
      targets.push(match[1])
    }
  }

  return targets
}

/**
 * import 先を実ファイルの絶対パスへ解決する。読み込めないものは null を返す。
 *
 * リポジトリ外（`~/.claude/CLAUDE.md` 等）は他プロジェクトと共有され CI からも見えないため、
 * 上限の対象にしない。
 *
 * @param {string} target import 先として書かれた文字列
 * @param {string} sourceDir import 元ファイルのあるディレクトリ（絶対パス）
 * @returns {string | null} 解決した絶対パス
 */
function resolveImport(target, sourceDir) {
  if (target.startsWith('~') || /^[a-z]+:/i.test(target)) return null

  const base = target.startsWith('/') ? repoRoot : sourceDir
  const resolved = resolve(base, target.replace(/^\//, ''))

  if (!resolved.startsWith(repoRoot)) return null
  if (!existsSync(resolved) || !statSync(resolved).isFile()) return null
  return resolved
}

/**
 * CLAUDE.md 1本の消費文字数を測る。`@` 記法で import したファイルを再帰的に合算する。
 *
 * import に逃がしても自動ロードされる以上、消費するコンテキストは変わらない。合算しないと
 * 上限が意味を失う。
 *
 * @param {string} claudeMdPath 測る CLAUDE.md の絶対パス
 * @returns {{ total: number, breakdown: { path: string, characters: number }[] }} 合計と内訳
 */
export function measureClaudeMd(claudeMdPath) {
  const breakdown = []
  const visited = new Set()
  const queue = [claudeMdPath]

  while (queue.length > 0) {
    const current = queue.shift()
    if (visited.has(current)) continue
    visited.add(current)

    const source = readFileSync(current, 'utf8')
    breakdown.push({
      path: relative(repoRoot, current),
      characters: countCharacters(source)
    })

    for (const target of extractImportTargets(source)) {
      const resolved = resolveImport(target, dirname(current))
      if (resolved) queue.push(resolved)
    }
  }

  return { total: breakdown.reduce((sum, entry) => sum + entry.characters, 0), breakdown }
}

/**
 * 上限を超えた CLAUDE.md を返す。
 *
 * @param {string[]} claudeMdPaths 検査対象の絶対パス
 * @returns {{ path: string, total: number, breakdown: { path: string, characters: number }[] }[]} 超過したもの
 */
export function findOversized(claudeMdPaths) {
  return claudeMdPaths
    .map((path) => ({ path: relative(repoRoot, path), ...measureClaudeMd(path) }))
    .filter((result) => result.total > CHARACTER_LIMIT)
}

/**
 * 超過を人間と AI の両方が読める文章にする。直し方（圧縮ではなく移す）まで書く。
 *
 * @param {{ path: string, total: number, breakdown: { path: string, characters: number }[] }[]} oversized 超過したもの
 * @returns {string} 報告文
 */
export function formatViolations(oversized) {
  const lines = [`CLAUDE.md が上限 ${CHARACTER_LIMIT} 文字を超えています。`]

  for (const { path, total, breakdown } of oversized) {
    lines.push(`  ${path}: ${total} 文字（超過 ${total - CHARACTER_LIMIT}）`)
    if (breakdown.length > 1) {
      for (const entry of breakdown) {
        lines.push(`    - ${entry.path}: ${entry.characters} 文字（@ import 先を合算）`)
      }
    }
  }

  lines.push(
    '',
    '直し方: 文章を圧縮して詰め込んではいけません。docs/policy/policy-driven-development-policy.md',
    'の「CLAUDE.md には、発火点を機械が判定できない指示だけを置く」に従い、発火点をパス・コマンド・',
    'Skill 名で言える指示を Policy・rules・hook・Skill のどれかへ移してください。移し先が無ければ',
    '自分で決めず、AskUserQuestion で人間に問うてください。'
  )

  return lines.join('\n')
}

/**
 * Git の追跡下にある CLAUDE.md をすべて返す（ルート・サブディレクトリの両方）。
 *
 * @returns {string[]} 絶対パス
 */
function collectTrackedClaudeMd() {
  return execFileSync('git', ['ls-files', 'CLAUDE.md', '**/CLAUDE.md'], {
    cwd: repoRoot,
    encoding: 'utf8'
  })
    .split('\n')
    .filter(Boolean)
    .map((file) => join(repoRoot, file))
}

function main() {
  const targets = collectTrackedClaudeMd()
  const oversized = findOversized(targets)

  if (oversized.length === 0) {
    for (const path of targets) {
      const { total } = measureClaudeMd(path)
      console.log(`${relative(repoRoot, path)}: ${total} / ${CHARACTER_LIMIT} 文字`)
    }
    return
  }

  console.error(formatViolations(oversized))
  process.exit(1)
}

// CI・npm scripts から直接実行されたときだけ検査する（hook からは関数として読み込まれる）
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
