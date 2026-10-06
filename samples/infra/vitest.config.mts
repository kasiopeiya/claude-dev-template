import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // テスト環境の設定
    environment: 'node',

    // describe / test / expect をimportなしで使う
    globals: true,

    // テストファイルのパターン
    include: ['test/**/*.test.ts'],

    // cdk synth はテンプレート合成に時間がかかるため、デフォルト(5秒)では足りない
    testTimeout: 120_000,

    // beforeAll 等で synth する構成に備えて hook 側も同じ上限にする
    hookTimeout: 120_000,

    // スナップショットシリアライザー
    snapshotSerializers: ['./test/snapshot-plugin.ts']
  }
})
