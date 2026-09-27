import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',

    // archunit の toPassAsync マッチャはグローバル登録されるため globals が必須
    globals: true,

    include: ['test/**/*.test.ts'],

    // /code-review のテストレンズは coverage/coverage-final.json（istanbul の json 形式）から未実行の分岐を読む。
    // 有効にするのは test:coverage（--coverage）のときだけ
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json'],
      // テストが読み込まなかった実装ファイルも、全分岐を未実行としてレポートに載せる
      include: [
        'domain/**/*.ts',
        'usecase/**/*.ts',
        'infrastructure/**/*.ts',
        'presentation/**/*.ts',
        'main.ts'
      ]
    }
  }
})
