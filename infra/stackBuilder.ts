/**
 * 環境ごとにスタックを構築するためのビルダークラス
 * 開発環境のみ使用するスタックなどがあることを考慮し、環境別にビルダークラスを分離
 */

import { type App, type Stack } from 'aws-cdk-lib'

import { devParameter, stgParameter, prdParameter, type Parameter } from './parameter'
import { BaseStack } from './lib/stack/baseStack'
import { AppStack } from './lib/stack/appStack'

/**
 * 開発環境のスタック構築
 */
export class DevStackBuilder {
  
  constructor(
    private readonly app: App,
    private readonly param: Parameter = devParameter
  ) {}

  build(): Stack[] {
    const baseStack = new BaseStack(this.app, `${this.param.prefix}-base-stack`, { env: this.param.env })
    const appStack = new AppStack(this.app, `${this.param.prefix}-app-stack`, {
      env: this.param.env,
      topic: baseStack.topic
    })
    return [baseStack, appStack]
  }
}

/**
 * 検証環境のスタック構築
 */
export class StgStackBuilder {
  
  constructor(
    private readonly app: App,
    private readonly param: Parameter = stgParameter
  ) {}

  build(): Stack[] {
    const baseStack = new BaseStack(this.app, `${this.param.prefix}-base-stack`, { env: this.param.env })
    const appStack = new AppStack(this.app, `${this.param.prefix}-app-stack`, {
      env: this.param.env,
      topic: baseStack.topic
    })
    return [baseStack, appStack]
  }
}

/**
 * 本番環境のスタック構築
 */
export class PrdStackBuilder {
  
  constructor(
    private readonly app: App,
    private readonly param: Parameter = prdParameter
  ) {}

  build(): Stack[] {
    const baseStack = new BaseStack(this.app, `${this.param.prefix}-base-stack`, { env: this.param.env })
    const appStack = new AppStack(this.app, `${this.param.prefix}-app-stack`, {
      env: this.param.env,
      topic: baseStack.topic
    })
    // 本番環境のみAlarm通知が必須
    appStack.addAlarms()
    return [baseStack, appStack]
  }
}
