import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',

    // archunit の toPassAsync マッチャはグローバル登録されるため globals が必須
    globals: true,

    include: ['test/**/*.test.ts']
  }
})
