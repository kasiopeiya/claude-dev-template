#!/usr/bin/env node
// 責務: 3階層の npm 依存を監査し、high 以上の脆弱性で CI を落とす。
//   ただし「上流に修正版が無く、手元で直しようがない」ものだけは、根拠と失効条件を添えて許容する。
//   許容は腐る（上流が直したのに例外だけ残る）ので、使われなくなった例外は逆にエラーにする。

import { execFileSync } from 'child_process'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

// 脆弱性は「どこを変更したか」ではなく「このリポジトリが危ういか」の事実なので、階層を分けず全部舐める（cicd-design）
const AUDIT_DIRECTORIES = ['.', 'samples/app/backend', 'samples/infra']

// どこから落とすか。high 未満を落とさないのは、受容するかが人間の判断だから（cicd-design）
const SEVERITY_ORDER = ['info', 'low', 'moderate', 'high', 'critical']
const FAILING_SEVERITY = 'high'

/**
 * 許容する脆弱性。**上流に修正版が存在せず、手元の設定では直せないものに限る。**
 * バージョンを上げれば直るものは許容せず、上げて直す。
 *
 * `nodePathPrefix` で混入経路を1つに縛るのが要点。同じパッケージの同じ脆弱性でも、
 * 別経路（自分たちが直接足した依存など）で入ってきたものは許容せず落とす。
 */
const ALLOWED_VULNERABILITIES = [
  // samples/infra の brace-expansion は aws-cdk-lib が同梱していて、lockfile からは上げられない。
  // 根拠: aws-cdk-lib の最新版 2.272.0 も、brace-expansion 5.0.9 を同梱している（2026-10-03 確認）。
  // 失効条件: 同梱版が 5.0.12 以上の aws-cdk-lib が出たら、上げてこの3エントリを削除する。
  {
    directory: 'samples/infra',
    packageName: 'brace-expansion',
    advisoryUrl: 'https://github.com/advisories/GHSA-q2hr-2g5m-vwhr',
    nodePathPrefix: 'node_modules/aws-cdk-lib/node_modules/brace-expansion'
  },
  {
    directory: 'samples/infra',
    packageName: 'brace-expansion',
    advisoryUrl: 'https://github.com/advisories/GHSA-qhr7-859c-m2p7',
    nodePathPrefix: 'node_modules/aws-cdk-lib/node_modules/brace-expansion'
  },
  {
    directory: 'samples/infra',
    packageName: 'brace-expansion',
    advisoryUrl: 'https://github.com/advisories/GHSA-6j4f-fj2g-mc7p',
    nodePathPrefix: 'node_modules/aws-cdk-lib/node_modules/brace-expansion'
  },
  // samples/app/backend の braces は archunit → plantuml-parser → fast-glob → micromatch の先にあり、直せない。
  // 根拠: braces は 3.0.3 以下が脆弱で、最新版も 3.0.3 のまま（2026-10-03 確認）。archunit の最新版 2.5.4 も
  //   plantuml-parser ^0.4.0 に依存し、plantuml-parser の最新版 0.4.0 も fast-glob 3.x を使う。
  // 失効条件: 修正版の braces が出たら `npm audit fix` で上げ、このエントリを削除する。
  {
    directory: 'samples/app/backend',
    packageName: 'braces',
    advisoryUrl: 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm',
    nodePathPrefix: 'node_modules/braces'
  }
]

/**
 * npm audit を JSON で実行する。脆弱性があると npm は非ゼロ終了するため、その場合も標準出力を読む。
 *
 * @param {string} directory リポジトリ相対のディレクトリ
 * @returns {{ vulnerabilities?: Record<string, object> }} 監査レポート
 */
function runAudit(directory) {
  try {
    return JSON.parse(
      execFileSync('npm', ['audit', '--json', '--prefix', directory], {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024
      })
    )
  } catch (error) {
    if (!error.stdout) throw error
    return JSON.parse(error.stdout)
  }
}

/**
 * 開示情報を持つ脆弱性について、開示情報と混入経路の組をすべて許容しているエントリを探す。
 *
 * @param {object} vulnerability npm audit の1エントリ
 * @param {object[]} advisories その脆弱性の開示情報（via のうちオブジェクトのもの）
 * @param {{ directory: string, allowlist: typeof ALLOWED_VULNERABILITIES }} context 監査対象ディレクトリと許容リスト
 * @returns {object[] | null} 効いた許容エントリ。1組でも未許容なら null
 */
function findAdvisoryEntries(vulnerability, advisories, { directory, allowlist }) {
  const entryFor = (advisoryUrl, nodePath) =>
    allowlist.find(
      (entry) =>
        entry.directory === directory &&
        entry.packageName === vulnerability.name &&
        entry.advisoryUrl === advisoryUrl &&
        nodePath.startsWith(entry.nodePathPrefix)
    )

  const entries = advisories.flatMap((advisory) =>
    vulnerability.nodes.map((nodePath) => entryFor(advisory.url, nodePath))
  )
  return entries.includes(undefined) ? null : entries
}

/**
 * その脆弱性を覆っている許容エントリを探す。
 *
 * 開示情報を持つ脆弱性は、開示情報も混入経路もすべて許容済みのときだけ覆われる。1つでも未許容が混じれば覆われていない。
 * 開示情報を持たず、原因パッケージの名前だけを指す傍系（via が文字列だけ）は、指している原因がすべて覆われているときだけ覆われる。
 * 原因が1つでも未許容なら傍系も落ちる。傍系が通るのは、原因が根拠付きで許容リストに載っているときだけなので、原因は隠れない。
 *
 * @param {object} vulnerability npm audit の1エントリ
 * @param {{ directory: string, allowlist: typeof ALLOWED_VULNERABILITIES, vulnerabilityByName: Record<string, object> }} context 監査対象ディレクトリ・許容リスト・監査レポートの脆弱性
 * @param {Set<string>} [pathNames] 原因をたどってきた経路の脆弱性名（循環を止める）
 * @returns {object[] | null} 効いた許容エントリ。覆われていなければ null
 */
function findCoveringEntries(vulnerability, context, pathNames = new Set()) {
  const advisories = vulnerability.via.filter((via) => typeof via === 'object')
  if (advisories.length > 0) return findAdvisoryEntries(vulnerability, advisories, context)

  const causeNames = vulnerability.via
  if (causeNames.length === 0 || pathNames.has(vulnerability.name)) return null

  const causePathNames = new Set([...pathNames, vulnerability.name])
  const causeEntries = causeNames.map((causeName) => {
    const cause = context.vulnerabilityByName[causeName]
    return cause ? findCoveringEntries(cause, context, causePathNames) : null
  })
  return causeEntries.includes(null) ? null : causeEntries.flat()
}

/**
 * その脆弱性が許容リストで丸ごと覆われているかを判定する。覆われていれば、効いた許容エントリを記録する。
 *
 * @param {object} vulnerability npm audit の1エントリ
 * @param {Set<string>} matchedKeys 実際に効いた許容エントリの記録先（副作用）
 * @param {Parameters<typeof findCoveringEntries>[1]} context 監査対象ディレクトリ・許容リスト・監査レポートの脆弱性
 * @returns {boolean} 覆われていれば true
 */
function isFullyAllowed(vulnerability, matchedKeys, context) {
  const entries = findCoveringEntries(vulnerability, context)
  if (entries === null) return false

  for (const entry of entries) matchedKeys.add(allowlistKey(entry))
  return true
}

/**
 * 許容エントリの同一性キー。どのエントリが実際に効いたかを数えるために使う。
 *
 * @param {(typeof ALLOWED_VULNERABILITIES)[number]} entry 許容エントリ
 * @returns {string} キー
 */
function allowlistKey(entry) {
  return [entry.directory, entry.packageName, entry.advisoryUrl, entry.nodePathPrefix].join(' | ')
}

/**
 * 監査レポートから、許容されていない high 以上の脆弱性を抜き出す。
 *
 * 「別の脆弱パッケージのとばっちり」（via が文字列だけ）は、原因側がすべて許容済みのときだけ覆われた判定にする。
 * 原因側が未許容なら、原因が落ちて一緒に見えるべきものなので、ここで通さない（安全側に倒す）。
 *
 * @param {{ vulnerabilities?: Record<string, object> }} report npm audit --json の出力
 * @param {string} directory 監査対象ディレクトリ
 * @param {typeof ALLOWED_VULNERABILITIES} allowlist 許容リスト
 * @returns {{ blocking: object[], matchedKeys: Set<string> }} 落とすべき脆弱性と、効いた許容エントリ
 */
function selectBlockingVulnerabilities(report, directory, allowlist) {
  const matchedKeys = new Set()
  const threshold = SEVERITY_ORDER.indexOf(FAILING_SEVERITY)
  const vulnerabilityByName = report.vulnerabilities ?? {}
  const context = { directory, allowlist, vulnerabilityByName }

  const blocking = Object.values(vulnerabilityByName)
    .filter((vulnerability) => SEVERITY_ORDER.indexOf(vulnerability.severity) >= threshold)
    .filter((vulnerability) => !isFullyAllowed(vulnerability, matchedKeys, context))

  return { blocking, matchedKeys }
}

/**
 * 1ディレクトリ分の結果を人が読める形で出す。
 *
 * @param {string} directory 監査対象ディレクトリ
 * @param {object[]} blocking 落とすべき脆弱性
 */
function reportDirectory(directory, blocking) {
  if (blocking.length === 0) {
    console.log(`  ${directory}: high 以上の脆弱性なし`)
    return
  }

  console.error(`  ${directory}: high 以上の脆弱性 ${blocking.length} 件`)
  for (const vulnerability of blocking) {
    console.error(`    ${vulnerability.name} (${vulnerability.severity}) ${vulnerability.range}`)
    for (const nodePath of vulnerability.nodes) console.error(`      経路: ${nodePath}`)
  }
}

function main() {
  const failedDirectories = []
  const usedKeys = new Set()

  for (const directory of AUDIT_DIRECTORIES) {
    const { blocking, matchedKeys } = selectBlockingVulnerabilities(
      runAudit(directory),
      directory,
      ALLOWED_VULNERABILITIES
    )
    for (const key of matchedKeys) usedKeys.add(key)
    reportDirectory(directory, blocking)
    if (blocking.length > 0) failedDirectories.push(directory)
  }

  const staleEntries = ALLOWED_VULNERABILITIES.filter((entry) => !usedKeys.has(allowlistKey(entry)))
  if (staleEntries.length > 0) {
    console.error(
      '\nもう当たらない許容エントリがあります。上流が直った可能性が高いので削除してください。'
    )
    for (const entry of staleEntries) {
      console.error(`  ${entry.directory}: ${entry.packageName} ${entry.advisoryUrl}`)
    }
    process.exit(1)
  }

  if (failedDirectories.length > 0) {
    console.error(`\nhigh 以上の脆弱性があります: ${failedDirectories.join(' ')}`)
    console.error('直し方: 依存を修正版へ上げてください。上流に修正版が無い場合だけ、')
    console.error(
      `根拠と失効条件を添えて ${'scripts/audit-dependencies.mjs'} の許容リストに追加します。`
    )
    process.exit(1)
  }

  console.log('\nhigh 以上の脆弱性はありません。')
}

main()
