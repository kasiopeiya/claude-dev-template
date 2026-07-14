// 責務: クリーンアーキテクチャの一方向依存（内側→外側の import 禁止）を機械的に強制する

import { projectFiles } from 'archunit'

describe('レイヤー境界: 内側は外側を import しない', () => {
  it('domain は usecase を import しない', async () => {
    await expect(
      projectFiles().inFolder('**/domain/**').shouldNot().dependOnFiles().inFolder('**/usecase/**')
    ).toPassAsync()
  })

  it('domain は infrastructure を import しない', async () => {
    await expect(
      projectFiles()
        .inFolder('**/domain/**')
        .shouldNot()
        .dependOnFiles()
        .inFolder('**/infrastructure/**')
    ).toPassAsync()
  })

  it('domain は presentation を import しない', async () => {
    await expect(
      projectFiles()
        .inFolder('**/domain/**')
        .shouldNot()
        .dependOnFiles()
        .inFolder('**/presentation/**')
    ).toPassAsync()
  })

  it('usecase は infrastructure を import しない', async () => {
    await expect(
      projectFiles()
        .inFolder('**/usecase/**')
        .shouldNot()
        .dependOnFiles()
        .inFolder('**/infrastructure/**')
    ).toPassAsync()
  })

  it('usecase は presentation を import しない', async () => {
    await expect(
      projectFiles()
        .inFolder('**/usecase/**')
        .shouldNot()
        .dependOnFiles()
        .inFolder('**/presentation/**')
    ).toPassAsync()
  })
})
