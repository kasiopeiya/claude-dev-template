import 'vitest'
import type { CheckOptions } from 'archunit'

// archunit が `declare global { interface VitestAssertion }` で型を足す先は、
// vitest 4 まで `Assertion` が継承していたグローバルインターフェースだった。
// vitest 5 で `Assertion` は `declare module 'vitest'` 内の同名インターフェースへ変わり、
// グローバル宣言では届かなくなったため、ここで `vitest` モジュールへ直接マージし直す。
// `import 'vitest'` が無いとこの declare module は「モジュール拡張」ではなく
// 独立した空間として扱われ、実際の Assertion にマージされない（要 side-effect import）。
// 実行時のマッチャー登録は archunit 側の副作用 import（`archunit` の import で自動実行）のまま変えていない。
// TestResult は archunit の公開APIから export されていないため、実体と同じ形を書き写している。
declare module 'vitest' {
  // 宣言マージ対象の型引数 R・T は本体で使わないが、TS2428（型引数の不一致）を避けるため
  // vitest 本家の Assertion と同じ名前・制約・デフォルト値で揃える必要がある。
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Assertion<R extends void | Promise<void> = void, T = unknown> {
    toPassAsync(options?: CheckOptions): Promise<{ pass: boolean; message: () => string }>
  }
}
