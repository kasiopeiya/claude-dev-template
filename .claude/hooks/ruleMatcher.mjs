// 責務: 編集対象パスにどの Rule（`.claude/rules/*.md`）が適用されるかの判定のみを担う。
//
// 設計意図（WHY）:
// - Rule は対象ファイルを Read した時点で標準ロードされる。新規ファイルは Read が発生せず
//   標準ロードが効かないため、policy-loader.mjs が対象ファイル不在時だけこのマッチャーで
//   肩代わりする（policy-driven-development-policy「Rule は既定で paths による標準ロードで届ける」）。
// - `paths`（標準ロードの肩代わり）に加えて `hook.applies-to` にも対応する。名指しのパス
//   （docs/policy/**・docs/ 直下のハブ）を `paths` に書くとハブや他ポリシーにも掛かって
//   しまうため、Policy と同じ `hook.applies-to` で編集時にだけ注入するルートを別に持つ。
// - Rule の中身は一切持たない。どのファイルにどの Rule が効くかは各 Rule 側の frontmatter
//   （`paths` または `hook.applies-to`）が宣言し、ここはそれを走査してマッチを集めるだけ。
//   policyMatcher.mjs と同じ形。

import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  convertGlobToRegExp,
  extractFrontmatter,
  parseFrontmatterList
} from './frontmatterList.mjs'

/** rulesDir 配下（サブディレクトリを含む）の *.md を走査し、frontmatter の frontmatterKey が targetRelativePath にマッチする Rule のファイル名配列を返す。 */
function collectRuleNamesMatching(targetRelativePath, rulesDir, frontmatterKey) {
  const matchedRuleNames = []
  for (const name of readdirSync(rulesDir, { recursive: true })) {
    if (!name.endsWith('.md')) continue
    const frontmatter = extractFrontmatter(readFileSync(resolve(rulesDir, name), 'utf8'))
    const globs = frontmatter ? parseFrontmatterList(frontmatter, frontmatterKey) : []
    if (globs.some((glob) => convertGlobToRegExp(glob).test(targetRelativePath))) {
      matchedRuleNames.push(name)
    }
  }
  return matchedRuleNames
}

/** `paths` にマッチする Rule のファイル名配列を返す（標準ロードの肩代わり）。 */
export function collectMatchingRules(targetRelativePath, rulesDir) {
  return collectRuleNamesMatching(targetRelativePath, rulesDir, 'paths')
}

/** `hook.applies-to` にマッチする Rule のファイル名配列を返す（名指しのパスへの編集時注入）。 */
export function collectRulesByAppliesTo(targetRelativePath, rulesDir) {
  return collectRuleNamesMatching(targetRelativePath, rulesDir, 'applies-to')
}
