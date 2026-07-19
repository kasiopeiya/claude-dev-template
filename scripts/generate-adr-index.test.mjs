// 責務: adr-index 生成の純関数（frontmatter パース・行素材化・表組み立て）を合成入力で検証する。
//   実在の ADR ファイルには依存させない（無関係な変更で壊れないため）。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseFrontmatter, extractTitle, toAdrEntry, buildTable } from './generate-adr-index.mjs'

const adr = (front, title) => `---\n${front}\n---\n\n# ADR-001: ${title}\n\n本文`

test('parseFrontmatter は key: value 行だけを読む', () => {
  const front = parseFrontmatter('---\nstatus: accepted\ndate: 2026-07-18\n---\n# 本文')
  assert.equal(front.status, 'accepted')
  assert.equal(front.date, '2026-07-18')
})

test('parseFrontmatter は frontmatter が無ければ空を返す', () => {
  assert.deepEqual(parseFrontmatter('# 見出しだけ'), {})
})

test('extractTitle は先頭の "ADR-NNN: " を落とす', () => {
  assert.equal(extractTitle('# ADR-007: 単一スタックにする\n本文'), '単一スタックにする')
})

test('toAdrEntry は番号・タイトル・status/date を素材化する', () => {
  const entry = toAdrEntry('001-foo.md', adr('status: proposed\ndate: 2026-07-18', 'フー'))
  assert.equal(entry.number, '001')
  assert.equal(entry.title, 'フー')
  assert.equal(entry.status, 'proposed')
  assert.equal(entry.date, '2026-07-18')
})

test('toAdrEntry は status 欠落を弾く', () => {
  assert.throws(
    () => toAdrEntry('001-foo.md', adr('date: 2026-07-18', 'フー')),
    /status がありません/
  )
})

test('toAdrEntry は未知の status を弾く', () => {
  assert.throws(
    () => toAdrEntry('001-foo.md', adr('status: wip\ndate: 2026-07-18', 'フー')),
    /未知の status/
  )
})

test('toAdrEntry は superseded で supersededBy 欠落を弾く', () => {
  assert.throws(
    () => toAdrEntry('001-foo.md', adr('status: superseded\ndate: 2026-07-18', 'フー')),
    /supersededBy/
  )
})

test('buildTable は status を日本語表示へ写す', () => {
  const table = buildTable([
    { number: '001', title: 'フー', file: '001-foo.md', status: 'proposed', date: '2026-07-18' }
  ])
  assert.match(table, /\| 001 \| \[フー\]\(001-foo\.md\) \| 提案 \| 2026-07-18 \|/)
})

test('buildTable は superseded に置換先を添える', () => {
  const table = buildTable([
    {
      number: '001',
      title: 'フー',
      file: '001-foo.md',
      status: 'superseded',
      date: '2026-07-18',
      supersededBy: '003'
    }
  ])
  assert.match(table, /置換（→ ADR-003）/)
})
