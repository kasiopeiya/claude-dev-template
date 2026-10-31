# テスト方針準拠チェック詳細

Phase 2（テスト作成）と Phase 4（実装）の準拠チェックで照合する項目と、違反時の対応・具体例。

## Phase 2（テスト作成）のチェック

合否の条件は、Rule の [unit-test.md](../../../rules/unit-test.md) とテスト方針ポリシーの [unit-test-policy.md](../../../../docs/policy/unit-test-policy.md) を Read して引く（Phase 2 の冒頭で読み込み済みなら再読は要らない）。

| 観点               | 違反時の対応                                               |
| ------------------ | ---------------------------------------------------------- |
| SUT の明示         | 修正                                                       |
| AAAパターン        | Act が複数行 → 警告（カプセル化の見直しを提案）            |
| フェーズコメント   | 条件に合わないコメントは削除／必要なのに無ければ追加       |
| テストケース命名   | 修正                                                       |
| テストダブル方針   | 警告（限定例外に当たるモックは、理由コメントの有無も見る） |
| テストデータの配置 | 警告（fixture ファイルの使用もここで見る）                 |
| テストケースの分離 | 分離を提案                                                 |
| パラメータ化テスト | 分離を提案                                                 |
| 検証対象           | 警告                                                       |
| テスト対象の妥当性 | テスト不要と警告                                           |
| テスト内 if 文     | テストケースの分割を提案                                   |
| フロントエンド固有 | 警告                                                       |

> SUT の明示・AAAパターン・フェーズコメント・テストケース命名・テストデータの配置・テストケースの分離・パラメータ化テストの NG/OK 例は Rule を、検証対象の NG/OK 例はポリシーの「振る舞いを検証し、実装の詳細を検証しない」を参照する。

### テストダブル方針

```typescript
// ❌ NGパターン: 内部関数のモック
vi.mock('./utils/helper')

// ❌ NGパターン: スタブとのやりとりを検証（過剰検証）
const stubRepository = { findById: vi.fn(() => ({ id: 'user-123', name: 'Alice' })) }
// ...テスト実行後...
expect(stubRepository.findById).toHaveBeenCalledWith('user-123') // スタブの検証は禁止

// ✅ OKパターン: スタブはデータ提供のみ、最終結果を検証
const stubRepository = { findById: () => ({ id: 'user-123', name: 'Alice' }) }
const result = await sut(event, context)
expect(result.statusCode).toBe(200)

// ✅ OKパターン: 呼び出し回数自体が仕様（キャッシュ）＝ポリシーの限定例外
// WHY: 2回目はキャッシュから返し、元データを呼ばないことが仕様のため
const mockFetchUser = vi.fn(() => ({ id: 'user-123', name: 'Alice' }))
```

### 違反時の警告フォーマット

```
⚠️ テスト方針違反を検出

Phase 2: テスト作成

違反内容:
- {違反した観点と、何がどう違反しているか}

対処方法:
1. {具体的な修正手順}

修正しますか？
[はい / このまま続行]
```

## Phase 4（実装）のチェック

生成した実装コードを全項目に照らして確認する。

| 観点         | ✅ 準拠                                | ❌ 違反時の対応                                             |
| ------------ | -------------------------------------- | ----------------------------------------------------------- |
| 最小限の実装 | テストを通すために必要な最小限のコード | テストにない機能の追加 → 警告、削除を提案                   |
| 最適化の禁止 | シンプルな実装                         | パフォーマンス最適化 → リファクタリングフェーズへ延期を提案 |
| コメント     | WHYコメント記載                        | WHATコメントのみ → 警告                                     |

### 最小限の実装

```typescript
// ❌ NGパターン: テストにない機能の追加
export function verifyState(
  state: string,
  expectedState: string,
  options?: { ignoreCase?: boolean } // 大文字小文字の無視（テストにない）
): boolean {
  if (options?.ignoreCase) {
    return state.toLowerCase() === expectedState.toLowerCase()
  }

  return state === expectedState
}

// ✅ OKパターン: 最小限の実装
export function verifyState(state: string, expectedState: string): boolean {
  return state === expectedState
}
```

### 過度な最適化の禁止

```typescript
// ❌ NGパターン: 最適化コード
export function verifyState(state: string, expectedState: string): boolean {
  // 長さチェックで早期リターン（最適化）
  if (state.length !== expectedState.length) {
    return false
  }

  return state === expectedState
}

// ✅ OKパターン: シンプルな実装
export function verifyState(state: string, expectedState: string): boolean {
  return state === expectedState
}
```

### 違反時の警告フォーマット

```
⚠️ TDD原則違反を検出

Phase 4: 実装

違反内容:
- {テストにない機能が実装されている等}

TDD原則:
- テストを通す最小限のコードのみ実装する

対処方法:
1. {具体的な修正手順}

修正しますか？
[はい / このまま続行]
```
