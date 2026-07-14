// 責務: 凝集度メトリクス(LCOM)を固定しきい値で検査し、クラスの凝集低下を信号として検知する

import { metrics } from 'archunit'

describe('凝集度メトリクス（固定しきい値・信号として使う）', () => {
  it('全クラスの LCOM96b がしきい値未満', async () => {
    // LCOM96b は 0(完全凝集)〜1(無凝集)。現状は全クラス 0 なので、
    // 凝集がおよそ半分失われた水準(0.5)を上限とし、余裕を持たせつつ劣化は検知する。
    await expect(metrics().lcom().lcom96b().shouldBeBelow(0.5)).toPassAsync()
  })
})
