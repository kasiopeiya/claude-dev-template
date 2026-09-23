#!/usr/bin/env node
// 責務: `.claude/rules/*.md`（Rule）が文字数上限に収まっているかを検査する。
//   上限と「超えたらどうするか」は docs/policy/policy-driven-development-policy.md が正典で、
//   ここはその判定だけを担う。Rule は対象ファイルを Read するたびに全文が読み込まれるため、
//   文字数がそのまま毎回のコンテキスト消費になる（Issue #543）。
//
// 判定ロジックはこのファイル1ヶ所にしか置かない。ターン末ゲートと CI の2経路から呼ばれる。

import { readFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { dirname, join, relative, resolve } from 'path'
import { fileURLToPath } from 'url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

export const CHARACTER_LIMIT = 6000

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
 * 上限を超えた Rule を返す。
 *
 * @param {string[]} rulePaths 検査対象の絶対パス
 * @returns {{ path: string, characters: number }[]} 超過したもの
 */
export function findOversized(rulePaths) {
  return rulePaths
    .map((path) => ({
      path: relative(repoRoot, path),
      characters: countCharacters(readFileSync(path, 'utf8'))
    }))
    .filter((result) => result.characters > CHARACTER_LIMIT)
}

/**
 * 超過を人間と AI の両方が読める文章にする。直し方（圧縮ではなく分ける）まで書く。
 *
 * @param {{ path: string, characters: number }[]} oversized 超過したもの
 * @returns {string} 報告文
 */
export function formatViolations(oversized) {
  const lines = [`Rule が上限 ${CHARACTER_LIMIT} 文字を超えています。`]

  for (const { path, characters } of oversized) {
    lines.push(`  ${path}: ${characters} 文字（超過 ${characters - CHARACTER_LIMIT}）`)
  }

  lines.push(
    '',
    '直し方: 文章を圧縮して詰め込んではいけません。docs/policy/policy-driven-development-policy.md',
    'の「Rule は既定で paths による標準ロードで届ける」に従い、paths を狭めて分けてください。',
    '同じ paths のまま分けても読み込まれる文字数は変わらないため、上限を逃れられません。'
  )

  return lines.join('\n')
}

/**
 * Git の追跡下にある Rule（`.claude/rules/*.md`）をすべて返す。
 *
 * @returns {string[]} 絶対パス
 */
function collectTrackedRules() {
  return execFileSync('git', ['ls-files', '.claude/rules/*.md'], {
    cwd: repoRoot,
    encoding: 'utf8'
  })
    .split('\n')
    .filter(Boolean)
    .map((file) => join(repoRoot, file))
}

function main() {
  const targets = collectTrackedRules()
  const oversized = findOversized(targets)

  if (oversized.length === 0) {
    for (const path of targets) {
      const characters = countCharacters(readFileSync(path, 'utf8'))
      console.log(`${relative(repoRoot, path)}: ${characters} / ${CHARACTER_LIMIT} 文字`)
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
