# CLAUDE.md

## 必読ドキュメント

@docs/project-context/project-claude.md

- **設計書ハブ**：着手前に `docs/design-hub.md` を読み、個別設計書はそこから辿る
- **用語集**：用語に迷ったら `docs/project-context/glossary.md` を引く
- **ポリシー（最優先）**：何かを起こす前に `docs/policy-hub.md` で該当ポリシーを読んで従う。反する提案・実装・操作はしない

> [!IMPORTANT]
> **（AI・必須）** **判断を迫られたら（トレードオフ・設計選択・複数解釈・優先順位など）、`docs/policy/refined-engineer-judgment-principles.md` を必ず参照する。** 全ポリシーの上位に立つ判断の北極星である。原則から明確に答えが出るならAIが自分で決めてよく、迷う余地が残るなら `AskUserQuestion` で確認する。

## AIへの基本指示

- 回答は日本語
- **何よりもまず目的を握る（最優先）**：目的は全判断の上位基準である（見失えば、速く進むほど遠ざかる）。着手前に目的を自分の言葉で一文にして必ず出力する（外に出して初めて人間が取り違えを正せる）
  - 後戻りコストが高い／複数の解釈が入りうる／次の項目の種類に当たる → `AskUserQuestion`（Plan モードは `ExitPlanMode`）で確認し、肯定を得るまで実装・編集しない
  - それ以外 → 「**目的：〇〇。この前提で進めます**」と宣言して着手する
  - 一文にできるかを内心で判定して出力を省かない（LLM はほぼ常にもっともらしい一文を作れるので、確認が永久に発火しない）
- **種類で進め方を提案する**：Issue 番号の無い作業指示のうち、新しい機能・仕組みの開発は `/grill-me` を `AskUserQuestion` で提案し、承認後に着手する。既存の改善・リファクタリングは Plan モードで調べて `/check-plan` を回し、計画を `ExitPlanMode` で示して承認を得る。断られたら指示どおり進め、それ以外の種類では提案しない。相談への回答で進め方を示すときも、この手順を含める
- **質問には回答で、指示には作業で応える**：「対応して」「直して」等の明確な作業指示があるときだけ着手し、それ以外は回答だけ返す
- **正直に振る舞う**：推測を断定せず、不確実なら「分からない」と言う。事実・推測・意見を区別し、読めば確かめられることは読んで確かめる。不可逆な操作（削除・公開・本番操作）の前は `AskUserQuestion` で確認する
- **重要な相談は３人で議論する**：設計方針・技術選定・進め方の相談では、意見を述べる前に `/devil` を確認なしで起動する（1セッション1回まで）。現物を読めば決着する問いには使わない
- **`AskUserQuestion` の選択肢は単体で読めるように書く**：question・label・description は本文と別パネルに出る。本文なしで選べるよう、対象を毎回名指しし、本文の略記や「上記の案」を持ち込まない
- **横展開して考える**：1つの変更は系全体に波及するので、修正・追加の指示では同じ対応が他にも要るか調べる。提案・確認に留めるのは、設計方針の選択など人間の判断を要するものだけ
- **本筋外の課題は起票する（broken-window）**：次のものはその場で直さず（脱線・コンフリクトを避ける）、提案でも済ませず（提案は流れて消える）、`/quick-issue` で確認なしに起票する
  - 割れ窓：悪い設計・誤った意思決定・質の低いコード・放置された TODO
  - 人間からの指摘：直したうえで、なぜ起きたか（指示が発火しなかった／どこにも無かった／判断を誤らせた）を一段掘り、再発防止案と起票する。直して終わると次のセッションで同じ失敗が起きる
  - ただし**いま編集したファイル内の問題は、自分が壊したものも元からの不備も、起票せずその場で直す**。判定は原因でなく編集したパスとの一致で行う（原因の判断を挟むと基準が甘くなる）
- **短く明快に書く**：どの文章も中学生が追える構造で書く（専門用語は可）。書く前に核を一文で決め、削除テスト（消して読者が困らない語・行は消す）を当てる。基準は `docs/policy/documentation-policy.md` と `.claude/rules/document-writing.md`
- **返事は結論から短く**：第一文で聞かれたことに答え切る（二択ならそう答える）。Skill が冒頭に別の要素を置けと指示していても、答えより先に出さない（読み手が答えを探す羽目になる）。前置き・断り書きは短く。作業中は、重要な発見・方向転換と、長く黙る前の「いま何をしているか」を一行で伝える
- **SubAgent は決められた場面でだけ使う**：Skill が名指ししたときと、ユーザーが明示的に求めたときだけ。数回のツール実行で済む調べ物や、自分の作業の点検し直しには使わない
- **元のフォルダで別セッションが動いているときだけ、編集・コミットは専用の worktree で行う**：別セッションの `git switch` で、自分のコミットが別ブランチに乗るため。着手時に `/git-commit` の「並行セッションを検出する」で数え、2以上ならそこの手順で worktree を切って入る

## 開発フロー

仕様駆動で開発する（`docs/guide/development-flow.md`）。

> [!IMPORTANT]
> **（AI・必須）** **issue番号だけで開発フローを自動追従する**：「issue 111 対応して」と番号だけ渡されたら、`gh issue view 111` の「実装フロー（使用するSkill）」の Skill を記載順に実行する。同セクションが無ければ下の一覧で決める。
>
> その前に、実装する Issue（open な子を持つ親なら着手する子）に `issue:checked` が無ければ、確認なしで `/issue-check #<番号>` を1件だけ打つ（対話でも行数の見積もりを通すため）。打った後に引き直し、open で `ai-fixable`・`issue:checked` があり、`needs-human-decision`・`ready-for-human`・open な子が無いときだけ着手する。それ以外は理由を伝えて止まる。週次チェックの Issue（`doc-consistency-weekly`・`code-policy-weekly` ラベル）はこの確認を省く

変更種別ごとの使用Skill（直接編集した場合／新規・大幅加筆の場合）：

- 設計書：`/quick-doc-review`／`/design`
- アプリ実装（samples/app 含む）：`/code-review`／`/code-dev`
- CDK（samples/infra 含む）：`/cdk-review`／`/cdk-dev`
- それ以外のコード（`scripts/`・`.claude/hooks/`・`eslint-rules/`・`.claude/skills/` 配下のスクリプト）：`/quick-code-review <パス>`／`/code-review <パス>`（パスを渡さないと `.mjs` 本体が外れる）
- CI ワークフロー（`.github/workflows/`）：どちらも `/actions-review`
- 要件定義書：`/quick-doc-review`／`/requirements-review`
- ADR（`docs/adr/`）：`/quick-doc-review`／`/create-adr`
- 上記以外の文書（ハーネスのプロンプト定義 `.claude/skills/`・`.claude/agents/`、ポリシー `docs/policy/`、`docs/` 配下、`CLAUDE.md`）：`/quick-doc-review`／`/doc-review`

## Issue 作業の共通ルール

- Issue 番号の無い作業指示は、小さくても着手前に起票する（相談を経たものは `/to-issues`、その場の指示は `/quick-issue`）
- **相談の承認は実装の許可ではない**：`/grill-me`・Plan モードを経た作業では、`ExitPlanMode` などの承認を「Issue にしてよい」承認として扱う。同じセッションで実装に進むのは人間が指示したときだけ
- **着手したら `npm run close-issues`・`npm run prune-merged-branches-and-worktrees`・`npm run move-issue-card -- <Issue番号>` を打つ**：着手とは、実装フローの Skill の起動直前と、その場で起票した Issue の編集を始める直前をいう。Issue を読むだけの Skill（`/issue-check`・`/issue-decide`・`/issue-split`・`/issue-deps`）では打たない。失敗しても作業は続ける
- **（厳守）** Issue の「タスク一覧」を1つずつ進め、完了ごとに `gh issue edit` でチェックを付ける
- タスク一覧がポリシーに反していたら従わない。着手前に、どのポリシーのどの規定に反するかを `gh issue comment` で書き、タスクを訂正してから進める
- **PR を経由する作業では Issue を閉じない**：マージで閉じる。片付けた Issue はすべて `/pr-body` に渡して `Closes` 行に載せる。push を人間に任せるときは、push 後に `/pr-body <Issue番号>` が要ると伝える。リポジトリに差分が出ない作業だけ、完了時に確認なしで `gh issue close` する。push・close の直前に `git status` で未コミットの変更が無いか確かめ、あればコミットする
- AI が `git push` する前に、デフォルトブランチ（`gh repo view --json defaultBranchRef --jq .defaultBranchRef.name` で引く）の最新を `git fetch` と `git merge --no-edit origin/<デフォルトブランチ>` で取り込む（rebase は使わない）。続けて `npm run gen:adr-index` を実行し、差分が出たらコミットする。push したら `/pr-body <Issue番号>` を実行する
