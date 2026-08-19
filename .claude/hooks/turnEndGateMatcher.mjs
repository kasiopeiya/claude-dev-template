// 責務: 変更パスの一覧から、ターン末に走らせるゲート（npm script）を選ぶ pure 関数のみを担う。
//
// 設計意図（WHY）:
// - I/O もハーネス契約も持たない純粋関数にすることで、合成入力だけで単体テストできる
//   （実在ファイルに依存させない）。対象を変えるときはこのファイルだけを直す。
// - ゲートを足すときは hook を増やさず、この表に1行足す（policy-driven-development-policy
//   「ターン末ゲートは1本に統合する」）。

/**
 * 変更パスがローカル静的ゲート（lint/knip/typecheck）の対象かを判定する。
 *
 * @param {string} normalizedPath スラッシュ区切りに正規化した、プロジェクトルート相対パス
 * @returns {boolean} 静的ゲートの対象なら true
 */
function isStaticGateTarget(normalizedPath) {
  // 生成物・依存・型定義はゲート対象外
  if (normalizedPath.includes('node_modules/')) return false
  if (normalizedPath.endsWith('.d.ts')) return false

  // samples/ は参照実装の置き場。AI が手本にするため、実装コードと同じゲートで守る
  const GATED_PREFIXES = ['app/', 'infra/', 'samples/']

  const isTypeScript = normalizedPath.endsWith('.ts') || normalizedPath.endsWith('.tsx')
  return isTypeScript && GATED_PREFIXES.some((prefix) => normalizedPath.startsWith(prefix))
}

/**
 * 変更パスがリポジトリ内の CLAUDE.md かを判定する。
 *
 * @param {string} normalizedPath スラッシュ区切りに正規化した、プロジェクトルート相対パス
 * @returns {boolean} 文字数ゲートの対象なら true
 */
function isClaudeMdTarget(normalizedPath) {
  if (normalizedPath.includes('node_modules/')) return false
  return normalizedPath === 'CLAUDE.md' || normalizedPath.endsWith('/CLAUDE.md')
}

// ゲートの定義そのものは package.json が持つ。ここが持つのは「どの変更で走らせるか」だけ。
const GATES = [
  { npmScript: 'check:static', isTarget: isStaticGateTarget },
  { npmScript: 'check:claude-md', isTarget: isClaudeMdTarget }
]

/**
 * 変更パスの一覧から、走らせるべきゲートの npm script 名を選ぶ。
 *
 * @param {string[]} changedRelativePaths プロジェクトルート相対の変更パス一覧
 * @returns {string[]} 走らせる npm script 名（対象が無ければ空配列）
 */
export function selectTurnEndGates(changedRelativePaths) {
  if (!Array.isArray(changedRelativePaths)) return []

  // Windows 区切りを正規化してから判定する
  const normalizedPaths = changedRelativePaths
    .filter((path) => typeof path === 'string' && path !== '')
    .map((path) => path.replaceAll('\\', '/'))

  return GATES.filter(({ isTarget }) => normalizedPaths.some(isTarget)).map(
    ({ npmScript }) => npmScript
  )
}
