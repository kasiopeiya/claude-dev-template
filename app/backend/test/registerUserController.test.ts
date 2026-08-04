// 責務: 境界の集約 catch が例外を性質で振り分け、内部詳細を利用者へ漏らさないことを検証する

import { TechnicalError } from '../domain/technicalError'
import { User } from '../domain/user'
import { UserRepository } from '../domain/userRepository'
import { InMemoryUserRepository } from '../infrastructure/inMemoryUserRepository'
import { RegisterUserController } from '../presentation/registerUserController'
import { RegisterUser } from '../usecase/registerUser'

/** 技術的例外の経路を再現するためのスタブ。永続化層の障害（接続断など）を模す。 */
class UnavailableUserRepository implements UserRepository {
  findById(): Promise<User | null> {
    return Promise.reject(new TechnicalError('connection to user store lost'))
  }

  save(): Promise<void> {
    return Promise.reject(new TechnicalError('connection to user store lost'))
  }
}

const buildControllerWith = (repository: UserRepository): RegisterUserController =>
  new RegisterUserController(new RegisterUser(repository))

describe('ユーザー登録コントローラ', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('登録できた場合に成功として登録されたIDを返す', async () => {
    const sut = buildControllerWith(new InMemoryUserRepository())

    const result = await sut.handle({ id: 'user-001', email: 'user@example.com' })

    expect(result).toEqual({ ok: true, message: 'registered: user-001' })
  })

  it('利用者が入力を直せば解消する失敗の場合に理由をそのまま返す', async () => {
    const sut = buildControllerWith(new InMemoryUserRepository())

    const result = await sut.handle({ id: 'user-001', email: 'not-an-email' })

    expect(result.ok).toBe(false)
    expect(result.message).toContain('invalid email')
  })

  it('システム側の障害の場合に内部詳細を伏せた汎用メッセージを返す', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const sut = buildControllerWith(new UnavailableUserRepository())

    const result = await sut.handle({ id: 'user-001', email: 'user@example.com' })

    expect(result.ok).toBe(false)
    expect(result.message).not.toContain('connection to user store lost')
  })

  it('システム側の障害の場合に追跡できるエラーログを出力する', async () => {
    // Arrange
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const sut = buildControllerWith(new UnavailableUserRepository())

    // Act
    await sut.handle({ id: 'user-001', email: 'user@example.com' })

    // Assert
    expect(errorLog).toHaveBeenCalledTimes(1)
    const loggedEntry = JSON.parse(String(errorLog.mock.calls[0]?.[0]))
    expect(loggedEntry).toMatchObject({ level: 'ERROR', userId: 'user-001' })
    expect(loggedEntry.errorCode).toBeTruthy()
  })

  it('システム側の障害の場合に利用者のメールアドレスをログへ含めない', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const sut = buildControllerWith(new UnavailableUserRepository())

    await sut.handle({ id: 'user-001', email: 'user@example.com' })

    expect(String(errorLog.mock.calls[0]?.[0])).not.toContain('user@example.com')
  })
})
