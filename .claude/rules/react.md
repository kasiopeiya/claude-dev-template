---
globs: frontend/**/*.{ts,tsx}
---

# React 実装ルール

[typescript.md](typescript.md) を継承し、ここでは **React / JSX / Hooks / TailwindCSS / Testing Library 固有の差分だけ**を定める。命名・import順序・コメント・例外処理などの共通ルールは typescript.md に従う。設計の判断軸（責務分割・状態スコープ・Props設計）は [frontend-design-policy.md](../../docs/policy/frontend-design-policy.md) を参照する。

## コンポーネント

- **関数コンポーネントのみを使う。** クラスコンポーネントは使わない（Hooks で表現でき、`this` の暗黙を増やさないため）
- コンポーネント名・ファイル名は **PascalCase で一致**させる（`UserCard` → `UserCard.tsx`）
- **1ファイル1コンポーネント**を原則とする。同一ファイルにしか使われない小さな下位コンポーネントは同居してよいが、外部から使うものは分割する

## Props

- Props は型（`type` または `interface`）で明示する。`any`・暗黙の `object` を使わない
- **boolean / フラグ Props で振る舞いを切り替えない。** これは [application-design-policy「ブーリアン引数アンチパターン」](../../docs/policy/application-design-policy.md) の UI 適用である。状態が割れるなら**コンポーネントを分ける**

```tsx
// ❌ フラグ Props で2つの責務を1つに詰め込む
<Button primary={true} />
<Button primary={false} />

// ✅ 役割ごとに分ける（名前が振る舞いを語る）。または variant を必須の判別ユニオンにする
<PrimaryButton />
<SecondaryButton />
// もしくは
type ButtonProps = { variant: 'primary' | 'secondary' }
```

- 子へ渡すだけの中継 Props を多段に増やさない。3段以上バケツリレーするなら Context か構造の見直しを検討する

## Hooks

- **Rules of Hooks を厳守する。** 条件分岐・ループ・early return より後で Hook を呼ばない（常にトップレベルで同じ順序で呼ぶ）
- カスタムフックは **`use` プレフィックス**で始める（`useUserSession`）。React がフックと認識し、lint が効く
- **`useEffect` を濫用しない。** Effect は「外部システムとの同期」にだけ使う。次は Effect にしない:
  - **Props / state から計算できる派生値** → レンダー中にそのまま計算する（state にコピーしない）
  - **ユーザー操作への反応** → イベントハンドラに書く

```tsx
// ❌ 派生値を Effect + state で持つ（再レンダーが二重に走り、同期ズレの温床）
const [fullName, setFullName] = useState('')
useEffect(() => { setFullName(`${first} ${last}`) }, [first, last])

// ✅ レンダー中に計算する
const fullName = `${first} ${last}`
```

- `useEffect` の**依存配列は正しく埋める**（lint の exhaustive-deps を無効化して誤魔化さない）。依存が多すぎると感じたら、それは責務分割のシグナル

## 状態管理

- **ローカル state を既定**にし、使う場所の近くに置く（colocation）
- **state の持ち上げ（lifting up）は必要になってから**行う（先回りしない。[frontend-design-policy.md](../../docs/policy/frontend-design-policy.md)）
- 横断的に共有する state はまず Context を使う。専用のグローバル状態ライブラリ（Redux/Zustand 等）の導入は ADR で判断する

## TailwindCSS / スタイリング

- **utility-first。** スタイルは原則 Tailwind のユーティリティクラスで当て、独自 `.css` ファイルの量産を避ける
- 条件付きクラスは文字列連結せず `clsx` / `cva` 等で組み立てる

```tsx
// ❌ 文字列連結（可読性が低く、条件が増えると壊れやすい）
<div className={'card ' + (active ? 'card-active' : '')} />

// ✅ clsx で条件を宣言的に
<div className={clsx('card', { 'card-active': active })} />
```

- **マジックな任意値（`w-[137px]` 等）を多用しない。** 寸法・色・間隔は Tailwind 設定のデザイントークンに寄せ、一貫性を保つ

## JSX

- 分岐は**早期 return** と**三項演算子**を使い分ける。「条件を満たさなければ何も描かない」は早期 return、「2つの見た目を出し分ける」は三項。`&&` で `0` 等のフォールシーな値をそのまま描画しない
- リストの `key` には**安定した一意キー**を使う。配列インデックスを key にしない（並び替え・挿入で破綻する）
- JSX 内に巨大な式・多段ネストの三項を書かない。読みづらくなったら変数か下位コンポーネントへ切り出す

## テスト実装ルール（Testing Library）

テストの**思想**（ユーザー視点で振る舞いを検証する・内部 state や props を直接検証しない・どの層に書くか）は [unit-test-policy.md §9](../../docs/policy/unit-test-policy.md) と [test-strategy-policy.md](../../docs/policy/test-strategy-policy.md)（フロントは統合テスト厚めのトロフィー型）に従う。ここでは Testing Library 固有の**実装戦術**だけを定める。

- **クエリの優先順位**：`getByRole` → `getByLabelText` → `getByText` → （最終手段）`getByTestId`。アクセシブルな属性で取得できるなら `data-testid` を増やさない
- ユーザー操作は **`userEvent` を `fireEvent` より優先**する（実際の操作に近く、フォーカス・入力の副作用まで再現する）
- 非同期の結果は **`findBy*` / `waitFor`** で待つ。`setTimeout` で固定時間待たない（flaky の温床）
- **スナップショットテストを濫用しない。** 大きな DOM スナップショットは脆く、壊れても何が問題か分からない。検証したい振る舞いを明示的に assert する
- ネットワークは **`fetch` を直接モックせず MSW（Mock Service Worker）で差し替える**。リクエスト/レスポンス境界で差すことで、統合テスト寄り（トロフィー型）の思想と整合する

```tsx
// ✅ ロールで取得し、userEvent で操作し、findBy で非同期結果を待つ
render(<LoginForm />)

await userEvent.type(screen.getByLabelText('メールアドレス'), 'a@example.com')
await userEvent.click(screen.getByRole('button', { name: '送信' }))

expect(await screen.findByText('ログインしました')).toBeInTheDocument()
```
