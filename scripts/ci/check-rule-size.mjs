#!/usr/bin/env node
// 責務: `.claude/rules/*.md`（Rule）が文字数上限に収まっているかを検査する。
//   上限と「超えたらどうするか」は docs/policy/policy-driven-development-policy.md が正典で、
//   ここはその判定だけを担う。Rule は対象ファイルを Read するたびに全文が読み込まれるため、
//   文字数がそのまま毎回のコンテキスト消費になる（Issue #543）。
//
// 判定ロジックはこのファイル1ヶ所にしか置かない。ターン末ゲートと CI の2経路から呼ばれる。

import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

import { listWorkingTreeFiles } from './list-working-tree-files.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')

const CHARACTER_LIMIT = 6000

function main() {
  const rulePaths = listWorkingTreeFiles(repoRoot, ['.claude/rules/*.md'])
  const measurements = rulePaths.map(measureRule)
  const oversized = measurements.filter(({ characters }) => characters > CHARACTER_LIMIT)

  if (oversized.length === 0) {
    for (const { path, characters } of measurements) {
      console.log(`${path}: ${characters} / ${CHARACTER_LIMIT} 文字`)
    }
    return
  }

  console.error(formatViolations(oversized))
  process.exit(1)
}

/**
 * 超過を人間と AI の両方が読める文章にする。直し方（圧縮ではなく分ける）まで書く。
 *
 * @param {{ path: string, characters: number }[]} oversized 超過したもの
 * @returns {string} 報告文
 */
function formatViolations(oversized) {
  const lines = [`Rule が上限 ${CHARACTER_LIMIT} 文字を超えています。`]

  for (const { path, characters } of oversized) {
    lines.push(`  ${path}: ${characters} 文字（超過 ${characters - CHARACTER_LIMIT}）`)
  }

  lines.push(
    '',
    '直し方: 文章を圧縮して詰め込んではいけません。docs/policy/policy-driven-development-policy.md',
    'の「文字数に上限を置き、超えたら圧縮ではなく分ける」に従い、paths を狭めて分けてください。',
    '同じ paths のまま分けても読み込まれる文字数は変わらないため、上限を逃れられません。',
    '対象が1ファイルなどで paths を狭められないときだけ、Rule をスタブにし本体を .claude/rule-bodies/ に置きます。'
  )

  return lines.join('\n')
}

/**
 * Rule 1本の文字数を測る。
 *
 * @param {string} rulePath 測る Rule のリポジトリ相対パス
 * @returns {{ path: string, characters: number }} 測った結果
 */
function measureRule(rulePath) {
  return {
    path: rulePath,
    characters: countCharacters(readFileSync(join(repoRoot, rulePath), 'utf8'))
  }
}

/**
 * `wc -m` と同じ数え方で文字数を返す（コードポイント単位。UTF-16 の符号単位ではない）。
 *
 * @param {string} text 数える対象の全文
 * @returns {number} 文字数
 */
function countCharacters(text) {
  return [...text].length
}

main()
