// 責務: 編集パスがローカル静的ゲート（lint/knip/typecheck）の対象かを判定する pure 関数のみを担う。
//
// 設計意図（WHY）:
// - I/O もハーネス契約も持たない純粋関数にすることで、合成入力だけで単体テストできる
//   （実在ファイルに依存させない）。判定ルールを変えるときはこのファイルだけを直す。

/**
 * 編集対象パスが app/・infra/ 配下の TypeScript（.ts / .tsx）かを判定する。
 * これに該当する編集は lint/knip/typecheck の静的ゲート対象なので、リマインドを出す。
 *
 * @param {string} targetRelativePath プロジェクトルートからの相対パス
 * @returns {boolean} 静的ゲートのリマインド対象なら true
 */
export function shouldRemindStaticCheck(targetRelativePath) {
  if (typeof targetRelativePath !== 'string' || targetRelativePath === '') return false

  // Windows 区切りを正規化してから判定する
  const normalizedPath = targetRelativePath.replaceAll('\\', '/')

  // 生成物・依存・型定義はゲート対象外
  if (normalizedPath.includes('node_modules/')) return false
  if (normalizedPath.endsWith('.d.ts')) return false

  const isTypeScript = normalizedPath.endsWith('.ts') || normalizedPath.endsWith('.tsx')
  const isInScope = normalizedPath.startsWith('app/') || normalizedPath.startsWith('infra/')
  return isTypeScript && isInScope
}
