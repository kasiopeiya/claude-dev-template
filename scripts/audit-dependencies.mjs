#!/usr/bin/env node
// 責務: 3階層の npm 依存を監査し、high 以上の脆弱性で CI を落とす。
//   ただし「上流が同梱していて手元で直しようがない」ものだけは、根拠と失効条件を添えて許容する。
//   許容は腐る（上流が直したのに例外だけ残る）ので、使われなくなった例外は逆にエラーにする。

import { execFileSync } from 'child_process'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

// 脆弱性は「どこを変更したか」ではなく「このリポジトリが危ういか」の事実なので、階層を分けず全部舐める（cicd-design）
const AUDIT_DIRECTORIES = ['.', 'app/backend', 'infra']

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
  {
    directory: 'infra',
    packageName: 'brace-expansion',
    advisoryUrl: 'https://github.com/advisories/GHSA-mh99-v99m-4gvg',
    nodePathPrefix: 'node_modules/aws-cdk-lib/node_modules/',
    reason:
      'aws-cdk-lib の bundledDependencies として tarball に同梱されており、overrides も npm audit fix も届かない。' +
      '最新の aws-cdk-lib も脆弱版を同梱しているため、手元に打てる手がない（Issue #110）',
    removeWhen:
      'aws-cdk-lib が修正版を同梱したら、この例外は未使用になりこのスクリプト自身がエラーで知らせる'
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
 * その脆弱性が許容リストで丸ごと覆われているかを判定する。
 *
 * 覆われたと言えるのは、開示情報も混入経路もすべて許容済みのときだけ。1つでも未許容が混じれば覆われていない。
 *
 * @param {object} vulnerability npm audit の1エントリ
 * @param {string} directory 監査対象ディレクトリ
 * @param {typeof ALLOWED_VULNERABILITIES} allowlist 許容リスト
 * @param {Set<string>} matchedKeys 実際に効いた許容エントリの記録先（副作用）
 * @returns {boolean} 覆われていれば true
 */
function isFullyAllowed(vulnerability, directory, allowlist, matchedKeys) {
  const advisories = vulnerability.via.filter((via) => typeof via === 'object')
  if (advisories.length === 0) return false

  const entriesFor = (advisoryUrl, nodePath) =>
    allowlist.find(
      (entry) =>
        entry.directory === directory &&
        entry.packageName === vulnerability.name &&
        entry.advisoryUrl === advisoryUrl &&
        nodePath.startsWith(entry.nodePathPrefix)
    )

  const pairs = advisories.flatMap((advisory) =>
    vulnerability.nodes.map((nodePath) => entriesFor(advisory.url, nodePath))
  )
  if (pairs.some((entry) => entry === undefined)) return false

  for (const entry of pairs) matchedKeys.add(allowlistKey(entry))
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
 * 「別の脆弱パッケージのとばっちり」（via が文字列だけ）は覆われた判定にしない。原因側が
 * 落ちれば一緒に見えるべきものであり、ここで通すと原因を隠しかねないため、安全側に倒す。
 *
 * @param {{ vulnerabilities?: Record<string, object> }} report npm audit --json の出力
 * @param {string} directory 監査対象ディレクトリ
 * @param {typeof ALLOWED_VULNERABILITIES} allowlist 許容リスト
 * @returns {{ blocking: object[], matchedKeys: Set<string> }} 落とすべき脆弱性と、効いた許容エントリ
 */
function selectBlockingVulnerabilities(report, directory, allowlist) {
  const matchedKeys = new Set()
  const threshold = SEVERITY_ORDER.indexOf(FAILING_SEVERITY)

  const blocking = Object.values(report.vulnerabilities ?? {})
    .filter((vulnerability) => SEVERITY_ORDER.indexOf(vulnerability.severity) >= threshold)
    .filter((vulnerability) => !isFullyAllowed(vulnerability, directory, allowlist, matchedKeys))

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
