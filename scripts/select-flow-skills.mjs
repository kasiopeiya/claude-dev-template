#!/usr/bin/env node
// 責務: 変更するファイルのパスごとに、変更種別と、回す Skill（直接編集した場合・新規・大幅加筆の場合）を
//   1行ずつ返すことだけを担う。変更種別と Skill の対応の正典はこのファイルの FLOW_SKILL_RULES である。
//
// 設計意図（WHY）:
// - 対応を CLAUDE.md の一覧に置くと、毎セッション全文が読み込まれ、文字数を占め続ける。パスから機械的に
//   決まる判定なので、毎回読む文章ではなくコードに置き、必要なときに打たせる。
// - 一覧を AI が読んで当てはめると、Skill ごとに言い直した写しが一覧と食い違う（Issue #1528）。
//   答えをここ1か所から出せば、言い直しが要らなくなる。
// - どちらの列を使うかは決めず、両方を出す。直接編集か新規・大幅加筆かは変更の規模の判断で、
//   パスだけでは決まらないため。
// - 1つのパスの種別は1つに決まるので、規則を上から当てて最初に当たった1つを採る。
//   順序に意味がある（例: 設計書は `.md` なので、その他の文書より上に置かないと、その他の文書に取られる）。
//   規則を足すときは、より狭い条件を上に置く。
// - 作業ツリーの外を指すパスは、「該当なし」にせず止める（終了コード 1）。「該当なし」は対象外のファイルと
//   見分けがつかず、呼んだ側がレビューを回さずに進むため。
//
// 使い方: npm run --silent select-flow-skills -- <パス>...
//   出力: <パス>\t<種別>\t直接編集：<Skill>\t新規・大幅加筆：<Skill>

import path from 'node:path'

const USAGE_MESSAGE =
  '変更するファイルのパスを渡してください（例: npm run --silent select-flow-skills -- scripts/close-issues.mjs CLAUDE.md）'

const PATH_PLACEHOLDER = '<パス>'

/**
 * @typedef {object} FlowSkillRule 変更種別1つ分の規則
 * @property {string} kind 変更種別の名前
 * @property {(normalizedPath: string) => boolean} isTarget スラッシュ区切りに正規化した、作業ツリーのルート相対パスが当たるか
 * @property {string} directEditSkill 直接編集した場合に回す Skill（PATH_PLACEHOLDER はパスに置き換える）
 * @property {string} newOrMajorAdditionSkill 新規・大幅加筆の場合に回す Skill（PATH_PLACEHOLDER はパスに置き換える）
 */

/**
 * 引数のパスごとに種別と Skill の1行を出す。作業ツリーの外のパスは stderr に名指しし、終了コードを 1 にする。
 */
function runCli() {
  const inputPaths = process.argv.slice(2)
  if (inputPaths.length === 0) {
    console.error(USAGE_MESSAGE)
    process.exitCode = 1
    return
  }

  for (const inputPath of inputPaths) {
    const normalizedPath = normalizePath(inputPath)
    if (normalizedPath === null) {
      console.error(`作業ツリーの外を指すパスは判定できません: ${inputPath}`)
      process.exitCode = 1
      continue
    }
    console.log(buildOutputLine(normalizedPath))
  }
}

/**
 * 正規化したパス1つについて、出力する1行を作る。
 *
 * @param {string} normalizedPath 作業ツリーのルート相対・スラッシュ区切りのパス
 * @returns {string} `<パス>\t<種別>\t直接編集：<Skill>\t新規・大幅加筆：<Skill>`
 */
function buildOutputLine(normalizedPath) {
  const rule = FLOW_SKILL_RULES.find(({ isTarget }) => isTarget(normalizedPath)) ?? NO_MATCH_RULE
  const fillPath = (skill) => skill.replaceAll(PATH_PLACEHOLDER, normalizedPath)
  return [
    normalizedPath,
    rule.kind,
    `直接編集：${fillPath(rule.directEditSkill)}`,
    `新規・大幅加筆：${fillPath(rule.newOrMajorAdditionSkill)}`
  ].join('\t')
}

/** @type {FlowSkillRule[]} */
const FLOW_SKILL_RULES = [
  {
    kind: 'CI ワークフロー',
    isTarget: isWorkflow,
    directEditSkill: '/actions-review',
    newOrMajorAdditionSkill: '/actions-review'
  },
  {
    kind: '要件定義書',
    isTarget: isRequirementsDoc,
    directEditSkill: '/quick-doc-review',
    newOrMajorAdditionSkill: '/requirements-review'
  },
  {
    kind: 'ADR',
    isTarget: isAdr,
    directEditSkill: '/quick-doc-review',
    newOrMajorAdditionSkill: '/create-adr'
  },
  {
    kind: '設計書',
    isTarget: isDesignDoc,
    directEditSkill: '/quick-doc-review',
    newOrMajorAdditionSkill: '/design'
  },
  {
    kind: 'アプリ実装',
    isTarget: isAppCode,
    directEditSkill: '/code-review',
    newOrMajorAdditionSkill: '/code-dev'
  },
  {
    kind: 'CDK',
    isTarget: isCdkCode,
    directEditSkill: '/cdk-review',
    newOrMajorAdditionSkill: '/cdk-dev'
  },
  {
    kind: 'その他のコード',
    isTarget: isOtherCode,
    directEditSkill: `/quick-code-review ${PATH_PLACEHOLDER}`,
    newOrMajorAdditionSkill: `/code-review ${PATH_PLACEHOLDER}`
  },
  {
    kind: 'その他の文書',
    isTarget: isMarkdown,
    directEditSkill: '/quick-doc-review',
    newOrMajorAdditionSkill: '/doc-review'
  }
]

/** どの規則にも当たらないときに返す規則 */
const NO_MATCH_RULE = {
  kind: '該当なし',
  directEditSkill: '該当なし（直接編集）',
  newOrMajorAdditionSkill: '該当なし（直接編集）'
}

/**
 * CI ワークフロー（`.github/workflows/` 配下の `.yml`・`.yaml`）かを判定する。
 *
 * @param {string} normalizedPath 正規化したパス
 * @returns {boolean} 当たれば true
 */
function isWorkflow(normalizedPath) {
  return (
    normalizedPath.startsWith('.github/workflows/') &&
    hasExtension(normalizedPath, ['.yml', '.yaml'])
  )
}

/**
 * 要件定義書かを判定する。範囲は requirements-doc-policy の applies-to に揃える。
 *
 * @param {string} normalizedPath 正規化したパス
 * @returns {boolean} 当たれば true
 */
function isRequirementsDoc(normalizedPath) {
  if (
    normalizedPath === 'docs/requirements.md' ||
    normalizedPath === 'samples/docs/requirements.md'
  )
    return true
  return normalizedPath.startsWith('docs/requirements-appendix/') && normalizedPath.endsWith('.md')
}

/**
 * ADR（`docs/adr/` 直下の `.md`）かを判定する。範囲は adr-policy の applies-to に揃える。
 *
 * @param {string} normalizedPath 正規化したパス
 * @returns {boolean} 当たれば true
 */
function isAdr(normalizedPath) {
  return /^docs\/adr\/[^/]+\.md$/.test(normalizedPath)
}

/**
 * 設計書かを判定する。範囲は design-doc-policy の applies-to に揃える。
 *
 * @param {string} normalizedPath 正規化したパス
 * @returns {boolean} 当たれば true
 */
function isDesignDoc(normalizedPath) {
  return (
    isUnderAny(normalizedPath, ['docs/design/', 'samples/docs/design/']) &&
    normalizedPath.endsWith('.md')
  )
}

/**
 * アプリ実装（`app/`・`samples/app/` 配下で `.md` 以外）かを判定する。
 *
 * @param {string} normalizedPath 正規化したパス
 * @returns {boolean} 当たれば true
 */
function isAppCode(normalizedPath) {
  return isUnderAny(normalizedPath, ['app/', 'samples/app/']) && !normalizedPath.endsWith('.md')
}

/**
 * CDK（`infra/`・`samples/infra/` 配下で `.md` 以外）かを判定する。
 *
 * @param {string} normalizedPath 正規化したパス
 * @returns {boolean} 当たれば true
 */
function isCdkCode(normalizedPath) {
  return isUnderAny(normalizedPath, ['infra/', 'samples/infra/']) && !normalizedPath.endsWith('.md')
}

/**
 * その他のコードかを判定する。範囲は /quick-code-review の「対象」節に揃える。
 *
 * @param {string} normalizedPath 正規化したパス
 * @returns {boolean} 当たれば true
 */
function isOtherCode(normalizedPath) {
  if (normalizedPath.startsWith('scripts/')) return hasExtension(normalizedPath, ['.mjs', '.sh'])
  if (isUnderAny(normalizedPath, ['.claude/hooks/', 'eslint-rules/']))
    return normalizedPath.endsWith('.mjs')
  if (normalizedPath.startsWith('.claude/skills/'))
    return hasExtension(normalizedPath, ['.py', '.sh', '.js'])
  return false
}

/**
 * `.md` かを判定する。設計書・ADR などの `.md` にも true を返すので、
 * 「その他の文書」の判定になるのは FLOW_SKILL_RULES でそれらより後に当てたときだけである。
 *
 * @param {string} normalizedPath 正規化したパス
 * @returns {boolean} `.md` なら true
 */
function isMarkdown(normalizedPath) {
  return normalizedPath.endsWith('.md')
}

/**
 * 入力のパスを、作業ツリーのルート相対・スラッシュ区切りにそろえる。
 * 相対パスは npm script を打った場所（INIT_CWD）から解決する。npm run は cwd を作業ツリーのルートへ
 * 移すので、process.cwd() から解決すると、サブディレクトリで打った相対パスを取り違えるため。
 *
 * @param {string} inputPath 引数で渡されたパス
 * @returns {string | null} 正規化したパス。作業ツリーの外を指すときは null
 */
function normalizePath(inputPath) {
  const workTreeRoot = process.cwd()
  const invokedDirectory = process.env.INIT_CWD ?? workTreeRoot
  const absolutePath = path.resolve(invokedDirectory, inputPath.replaceAll('\\', '/'))
  const relativePath = path.relative(workTreeRoot, absolutePath)
  const isOutsideWorkTree =
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  return isOutsideWorkTree ? null : relativePath.replaceAll('\\', '/')
}

/**
 * パスが、いずれかの接頭辞の配下にあるかを判定する。
 *
 * @param {string} normalizedPath 正規化したパス
 * @param {string[]} prefixes `/` で終わるディレクトリの接頭辞
 * @returns {boolean} 配下にあれば true
 */
function isUnderAny(normalizedPath, prefixes) {
  return prefixes.some((prefix) => normalizedPath.startsWith(prefix))
}

/**
 * パスの拡張子が、いずれかに当たるかを判定する。
 *
 * @param {string} normalizedPath 正規化したパス
 * @param {string[]} extensions `.` から始まる拡張子
 * @returns {boolean} 当たれば true
 */
function hasExtension(normalizedPath, extensions) {
  return extensions.some((extension) => normalizedPath.endsWith(extension))
}

runCli()
