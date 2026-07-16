// 責務: レイヤー間・ファイル間に循環依存が無いことを機械的に保証する

import { projectFiles } from 'archunit'

describe('循環依存', () => {
  it('ファイル間に循環依存が無い', async () => {
    await expect(projectFiles().inFolder('**').should().haveNoCycles()).toPassAsync()
  })
})
