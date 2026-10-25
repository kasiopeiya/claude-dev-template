---
hook:
  applies-to:
    [
      'scripts/setup-labels.sh',
      'scripts/auto-programmer/**/*.mjs',
      'scripts/move-issue-card.mjs',
      'scripts/auto-programmer/README.md',
      'scripts/ci/doc-consistency-weekly-issue.mjs',
      'scripts/ci/code-policy-weekly-issue.mjs',
      '.github/workflows/pr-ai-triage.yml',
      '.github/workflows/deploy-dev.yml',
      '.github/workflows/close-human-review-issue.yml',
      '.claude/agents/issue-auditor-agent/*.md',
      '.claude/skills/quick-issue/**/*.md',
      '.claude/skills/link-root-issue/**/*.md',
      'docs/project-context/issue-destinations.md',
      '.claude/skills/to-issues/**/*.md',
      '.claude/skills/issue-check/**/*.md',
      '.claude/skills/issue-split/**/*.md',
      '.claude/skills/issue-decide/**/*.md',
      '.claude/skills/issue-regroup/**/*.md',
      '.claude/skills/issue-deps/**/*.md',
      '.claude/skills/doc-consistency/**/*.md',
      '.claude/skills/sre-prr/**/*.md',
      '.claude/skills/auto-dev/**/*.md',
      '.claude/skills/auto-fix-ci/**/*.md',
      '.claude/skills/auto-resolve-conflict/**/*.md',
      '.claude/skills/design/SKILL.md',
      '.claude/skills/code-review/**/*.md',
      '.claude/skills/doc-review/**/*.md',
      '.claude/skills/cdk-review/**/*.md',
      '.claude/skills/arch-review/**/*.md',
      '.claude/skills/actions-review/**/*.md',
      '.claude/skills/requirements-review/**/*.md',
      'docs/policy/review-subagent-lens-policy.md',
      'docs/guide/development-flow.md',
      'docs/guide/new-development-guide.md'
    ]
---

# Issue ポリシー（ラベル・ボード Status・階層）

AIエージェントが、Issue を起票する・Issue のラベルを付け替える・ボードの Status を動かす・Issue の親を決める・ラベルや Status や Issue の親子の規則を説明する文書を書くときに参照する。Issue のラベル・ボード Status・階層の立場は、このポリシー1か所に置く（ここに置かないものの置き場は「このポリシーが決めること」の表にある）。置き場が Skill やガイドに散ると、変えるたびにどこを直せば全体が変わるのか分からなくなり、直し漏れで判断が食い違う（#996）。

> [!IMPORTANT]
> **TL;DR（このポリシーの決定事項）**
>
> - **Issue ラベルの意味・付ける条件・移し先と、ボード Status の意味は、このポリシーだけが持つ。** Skill・SubAgent・Policy は条件の文を書き写さず、条件の名前（例：「不可逆・外部に出る」）とこのポリシーの節名で参照する
> - **既定は `ai-fixable`。「人間が決めるべき Issue の条件」に当たるときは `needs-human-decision`、方針は決まっていて残る作業がすべて「人間しかできない作業の条件」に当たるときは `ready-for-human` にする。** 3択のどれか1つだけを必ず付ける。ただし、専用のラベルで扱いが決まっている Issue だけは、「3択の例外」として付けない
> - **AI の作業と人間しかできない作業が混ざるなら、人間の作業を別 Issue に切り出す。**
> - **人間が方針を決めたら、`ai-fixable` か `ready-for-human` に `issue:decided` を重ねる。**
> - **無人実行が予定した終わり方以外で止まったら、`needs-human-check` を重ねる。** 人間が確かめたら外す
> - **Issue の親子は分解の関係を表す。** 例外は最上位のルート Issue だけで、`phase` ラベルで探す。一度張った親子は、親の open な子が全部ブロッカー待ちになったときだけ動かす（親がルート Issue なら動かさない）。子を持つ親（ルート Issue を除く）には、`tracking-issue` を3択に重ねる
> - **分解元の Issue が親になる。分解元の無い Issue は、すべてルート Issue の sub-issue にする。** 使うルートと振り分け条件は、起票先ファイル（`docs/project-context/issue-destinations.md`）が決める。ルートに紐づける手順は `/link-root-issue` が持つ
> - **手順・書式・状態図はこのポリシーに置かない。** 選んだ後の How は各 Skill が持つ

## このポリシーが決めること

| このポリシーが決める                                          | 決めない（置き場所）                                                                            |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Issue ラベルの意味・付ける条件・移し先                        | ラベルを付ける手順・本文の書式（`/quick-issue` など各 Skill）                                   |
| 人間が決めるべき Issue の条件と、`issue:decided` を付ける条件 | 「人間が決めたこと」の行の形（`/quick-issue`）                                                  |
| 人間しかできない作業の条件と、混ざったときの切り出し          | 切り出す手順と、人間がするタスクの書き方（`/quick-issue`）                                      |
| 3択の例外                                                     | 状態の遷移を示す図（`/issue-decide`）                                                           |
| ボードの Status の意味                                        | Status を動かす手順と、ボードの表記の設定（`scripts/auto-programmer/README.md`）                |
| Issue の階層の意味と、親子を動かしてよい条件                  | 段番号（タイトル先頭の着手順の数字。`/quick-issue`）                                            |
| ルート Issue の方針と、親の決め方                             | このプロジェクトが使うルートと振り分け条件（`docs/project-context/issue-destinations.md`）      |
| —                                                             | ルート Issue の作成・紐付け・世代交代（上限に達したルートの後継を作ること。`/link-root-issue`） |
| —                                                             | 起点 Issue の種別と親（新規開発ガイド「起票する起点Issue」）                                    |
| —                                                             | Issue 作業の進め方（CLAUDE.md「Issue 作業の共通ルール」）                                       |
| —                                                             | PR のラベル（`pr-review-policy.md`「PRラベルと変更の種類」表）                                  |

## Issue に付けるラベル

| ラベル                                         | 意味                                                                                     | 付ける条件                                                                                                                                                       |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ai-fixable`                                   | 中身を見ずに AI が直せる。AI が単独で着手してよい対象を選ぶ印                            | 人間が決めるべき Issue の条件に当たらず、AI が実行できる作業が残るとき（既定）。当たっても人間が方針を決めたなら、`issue:decided` と一緒に付ける                 |
| `needs-human-decision`                         | 中身を見ずには直せない。人間が1件ずつ方針を決める対象を選ぶ印                            | 人間が決めるべき Issue の条件のどれかに当たり、人間がまだ方針を決めていないとき                                                                                  |
| `ready-for-human`                              | 方針は決まっているが、残る作業を AI が実行する手段を持たない。人間が作業する対象を選ぶ印 | 方針が決まっていて、残る作業がすべて下の「人間しかできない作業の条件」に当たるとき                                                                               |
| `issue:decided`                                | 人間が決めるべき Issue について、人間が方針を決めた                                      | 下の「人間が方針を決めたら `issue:decided` を付ける」の条件を満たすとき。`ai-fixable` か `ready-for-human` にだけ重ねる                                          |
| `issue:checked`                                | `/issue-check` が一度監査した。いま妥当である保証ではない                                | `/issue-check` が判定を出した Issue に、判定が何であれ貼る。監査できなかった・飛ばした Issue には貼らない                                                        |
| `broken-window`                                | AI が作業中に見つけ、その場で直さずに起票した問題                                        | AI が本筋外の問題を見つけて起票するとき（CLAUDE.md「本筋外の課題は起票する」と、それを引いて確認なしに起票するレビュー系 Skill）。人間が依頼した要望には付けない |
| `harness`                                      | ハーネスを変える Issue。ハーネスの手直しをプロダクト開発と分けて一覧する印               | 下の「`harness` を付ける条件」に当たるとき。起票する Skill が付ける                                                                                              |
| `tracking-issue`                               | 子を持つ親 Issue（ルート Issue を除く）。自分では実装せず、子に分けて進める単位          | 子を紐づけて親にした Skill が付ける。3択に重ねる。子が全部 close されても外さない。人間が GitHub の画面で子を紐づけたときは、人間が付ける（#1126）               |
| `needs-human-check`                            | 無人実行が問題で止まった。人間に確かめてほしい                                           | 下の「無人実行が止まったら `needs-human-check` を付ける」の条件に当たるとき                                                                                      |
| `phase`                                        | Issue 階層の最上位の常設 Issue（ルート Issue）                                           | ルート Issue にだけ付ける（3択の例外）                                                                                                                           |
| `requirement`                                  | 要件定義書のレビュー指摘に起因する Issue                                                 | `/requirements-review` が起票するとき、ほかのラベルに重ねる                                                                                                      |
| `doc-consistency-weekly`・`code-policy-weekly` | 週次ワークフローが起票した Issue を見分ける専用の印                                      | 週次スクリプトが `ai-fixable` と一緒に付ける。ラベルの当否は、着手前の `/issue-check` が見る                                                                     |
| `dev-deploy-failure`                           | dev への deploy が失敗した通知の Issue                                                   | `deploy-dev.yml` が起票するとき（3択の例外）                                                                                                                     |

PR に付く `needs-human-review` などのラベルの意味は `pr-review-policy.md` が持つ。このポリシーが扱うのは、そのラベルを付けて起票される通知の Issue（下の「3択の例外」）だけである。

## `harness` を付ける条件

次のどれかを変える Issue に `harness` を付ける。

- Policy（`docs/policy/`）
- Rule（`.claude/rules/`）
- Skill（`.claude/skills/`）
- SubAgent（`.claude/agents/`）
- hooks（`.claude/hooks/`）

[policy-driven-development-policy](policy-driven-development-policy.md) はハーネスの部品に CLAUDE.md とガードレール（静的解析設定・CI の検査）も数えるが、それらだけを変える Issue には付けない。人間が上の5つに絞った（#999）。

3択が「誰が何をするか」を表すのに対し、`harness` は「何を変えるか」を表す。軸が違うので、3択のどれにも重ねる。

## `tracking-issue` を3択に重ねる理由

3択が「誰が何をするか」を表すのに対し、`tracking-issue` は「実行タスクか、子をまとめる親か」を表す。軸が違うので、3択のどれにも重ねる。親も `ai-fixable` を持つので、GitHub Projects の Dashboard のカードだけでは、親と実行タスクを見分けられない。このラベルで見分ける（#1126）。子が全部 close されても外さないのは、予実管理などで親を分析の単位にするとき、親だった印で引けるようにするためである。

## 人間が決めるべき Issue の条件

次のどれかに当たる Issue は、AI が方針を決めず、人間が決める。取り返しがつかない、何を作るかが変わる、など、AI だけで決めると困るものを並べている。

当たれば `needs-human-decision`、当たらなければ `ai-fixable`（既定）か `ready-for-human`（下の「人間しかできない作業の条件」）を付ける。迷ったら `needs-human-decision` にする。ただし最後の「外部依存の制約を受けて…」だけは、確実と言い切れないなら当たらない扱いにする。

- **不可逆・外部に出る**：ファイル削除・公開・本番操作・外部サービス設定
- **要件／プロダクト方針が変わる**：「何を作るか」に触れる
- **ポリシー同士が正面衝突している**：どちらを優先するかの裁定が要る
- **比較に実測が要り、その手段が今ない**：性能・コストのトレードオフ
- **恒久的に保守が要る資産を新設する**：新規スクリプト・hook・CI ジョブ・外部依存の追加
- **書くべき設計書がまだ無い**：内容の書き先のどれにも当たらない。書き先の一覧と、上から当てる手順は、`/quick-issue` の `destination-rules` が持つ
- **着手前に仕様を詰める対話が要る**：`/grill-me` で詰めてから sub-issue に割る親Issue（新規開発ガイドの起点Issue）
- **外部依存の制約を受けて、計画や対応方針を見直すかを決める**：`/issue-check` が、本文にまだ示していない外部の製品・サービスの制約のうち、対応方針を確実に実行できなくするものを、一次資料で見つけた Issue。確実かどうかの見分け方（手順）は、`/issue-check` の「外部依存の前提の報告を判定に変える」が持つ

「恒久的に保守が要る資産を新設する」は**新設**にだけ当たる。新しいスクリプト・hook・CI ジョブ・外部依存を足すなら、既存の `package.json` やワークフローへの追記でも当たる。新しい資産を増やさない変更（既存ファイルの編集・ドキュメント／ポリシーの改訂・既存設定へのルール追加）は当たらない。足した仕組みは以後ずっと保守が要るので、増やすかどうかは人間が決める（[refined-engineer-judgment-principles](refined-engineer-judgment-principles.md)「YAGNI——必要になるまで作らない」のコードは負債）。

**「案が2つ以上ある」ことは `needs-human-decision` の理由にならない。** 推奨案が立つなら、その根拠と却下案を「対応方針」に書いて `ai-fixable` を付ける。ポリシーが裁定できる問いを人間に戻すと、AI に判断を委譲する仕組みが成立しない（CLAUDE.md「原則から明確に答えが出るなら AI が自分で決めてよい」）。

| 例                                                           | ラベル                        | なぜ                                 |
| ------------------------------------------------------------ | ----------------------------- | ------------------------------------ |
| タイポ・表記ゆれ                                             | `ai-fixable`                  | どの条件にも当たらない               |
| 新しい判断基準をどの文書に置くか                             | `ai-fixable`                  | 案は複数だがポリシーが裁定できる     |
| 既存の静的解析設定にルールを1つ足す                          | `ai-fixable`                  | 既存の仕組みの手直しで、新設ではない |
| 画面に CSV 出力を足す                                        | `needs-human-decision`        | 何を作るかが変わる                   |
| 内部の関数を、振る舞いを変えずに分割する                     | `ai-fixable`                  | 何を作るかは変わらない               |
| 参照先の実在を検証するスクリプトと CI ジョブを新設する       | `needs-human-decision`        | 恒久的に保守が要る資産の新設である   |
| 上と同じ新設を、スクリプト名とジョブ名を示して人間が承認した | `ai-fixable`＋`issue:decided` | 人間が方針を決めている               |
| ポリシーAとBが逆のことを言っている                           | `needs-human-decision`        | ポリシー同士が正面衝突している       |
| 使わなくなったディレクトリを消すか                           | `needs-human-decision`        | 不可逆である                         |
| 画像アップロードの仕様を書く設計書がまだ1件も無い            | `needs-human-decision`        | 書くべき設計書がまだ無い             |

## 人間しかできない作業の条件

次のどれかに当たる作業は、AI が実行する手段を持たない。方針が決まっていて、残る作業がすべてこれに当たる Issue には `ready-for-human` を付ける。方針がまだ決まっていなければ、先に方針を決めるので `needs-human-decision` にする。

- **人間専用の Skill や Auto-Programmer の起動**：モデルから呼べない Skill（frontmatter に `disable-model-invocation: true` を持つ）や `npm run auto-programmer` を、人間が打って結果を見る
- **新しいセッションでの確認**：CLAUDE.md・Skill・hook の変更が、新しく起動したセッションで効くかを見る。変更を読み込み済みのいまのセッションでは確かめられない
- **手元に無い環境での確認**：AI が動いている端末に無い OS・実機・アカウントで動かして見る
- **AI が権限を持たない画面での設定**：AI が使えるトークンやコマンドでは変えられない設定画面で、人間が設定する

**AI に実行手段がある作業は当たらない。** 不可逆な操作も、人間が方針を決めたら `ai-fixable` と `issue:decided` にして AI が実行する。人間の確認・検収が要るというだけでも当たらない。当たる扱いにすると、AI に任せられる作業まで無人実行から外れる。

**AI の作業と人間しかできない作業が1件に混ざるなら、人間の作業を別 Issue に切り出す。** 元の Issue には AI の作業だけを残して `ai-fixable` を付け、切り出した Issue に `ready-for-human` を付ける。混ざったまま `ready-for-human` を付けると、AI ができる部分まで止まる。例：スクリプトを直し、直した後に Windows 実機で動くか確かめる Issue は、2件に分ける。

## 人間が方針を決めたら `issue:decided` を付ける

人間が決めるべき Issue でも、人間が方針を決めたら、`needs-human-decision` ではなく `ai-fixable`（残る作業がすべて人間しかできない作業の条件に当たるなら `ready-for-human`）と `issue:decided` を付ける。その方針どおりに進めてよい。

`issue:decided` が要るのは、条件そのもの（不可逆である・新設である、など）は方針を決めた後も消えないからである。この印が無いと、`/issue-check` が同じ条件を見つけて `needs-human-decision` に戻してしまう。

「人間が決めた」と言えるのは、当たる条件の**すべて**について、人間が決めた発言を会話から引用できるときだけである。1つでも引用できなければ `needs-human-decision` にする。引用できる発言は、条件が人間に何を問うかで違う。

- **するかしないかを問う条件**（例：不可逆・外部に出る、恒久的に保守が要る資産を新設する）：対象を具体名で示し（例：`scripts/x.mjs` とその単体テスト、`docs/old/` の削除）、人間が承認した発言。具体名で示していない物は、決めていない扱いにする。人間が見ていない物まで通さないためである
- **裁定や中身を問う条件**（例：ポリシー同士が正面衝突している、書くべき設計書がまだ無い）：人間が裁定や中身そのものを述べた発言。「進めてよい」だけでは足りない

人間が決めた条件は、「対応方針」に「人間が決めたこと」として1条件1行で書く（行の形は `/quick-issue`）。`needs-human-decision` に戻されずに済むのは、この行に書いた条件だけである。`/issue-check` がどの条件を差し戻しの理由から外すかの細部は、`/issue-check` の監査基準が持つ。

## 無人実行が止まったら `needs-human-check` を付ける

無人実行（Auto-Programmer と、それが起動する `/auto-dev`・`/auto-fix-ci`・`/auto-resolve-conflict`）が予定した終わり方以外で止まったら、Issue に `needs-human-check` を付ける。止まった Issue を、人間がこのラベル1つで引けるようにするためである。止まり方ごとに印を変えたり、ボードの列で示したりすると、引き漏れる（#1000）。

予定した終わり方は次の4つだけで、どれか1つに当たれば付けず、ほかはすべて付ける。ただし処理中の例外とセッションの失敗は、4つのどれかに当たっていても付ける。付ける例：`/auto-dev`・`/auto-fix-ci` の離脱、上限まで直させても CI が通らない、CI の時間切れ・キャンセル、`/issue-check` の判定が書き戻されない。

- CI が通った
- 差分が出ない Issue を、`/auto-dev` が閉じた
- `/issue-check` の判定（人間判断・人間しかできない作業・close など）で止めた。人間への渡し方は、判定で付いたラベルと close が担う
- 子を1件以上、着手待ちに載せて引き継いだ

対話セッションでは付けない。対話で hook に起こされて動かした `/auto-fix-ci` も同じである。人間がその場に居るので、止まったことを知らせる印が要らない。3択は外さずに重ねる。止まっても、方針と作業の担い手は変わらないからである。外す場面は「ラベルの移し先」にある。

## ラベルの移し先

| 場面                                                                                                                                                                                     | 移し先                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `/issue-decide` で、人間が方針を決めた                                                                                                                                                   | `needs-human-decision` を外し、上の「人間が方針を決めたら `issue:decided` を付ける」のとおりに付ける             |
| `/issue-check` が、`ai-fixable` か `ready-for-human` の Issue は人間が決めるべき条件に当たると判定した（`issue:decided` 付きなら、「人間が決めたこと」の行に無い条件に当たると判定した） | `needs-human-decision` に貼り替える。`issue:decided` が付いていれば外す                                          |
| `/issue-check` が、`needs-human-decision` の Issue はどの条件にも当たらないと判定した                                                                                                    | `ai-fixable` に貼り替える。残る作業がすべて人間しかできない作業の条件に当たるなら `ready-for-human` に貼り替える |
| `/issue-check` が、`ai-fixable` の Issue は残る作業がすべて人間しかできない作業の条件に当たると判定した                                                                                  | `ready-for-human` に貼り替える                                                                                   |
| `/issue-check` が、`ready-for-human` の Issue に AI が実行する手段のある作業が残ると判定した                                                                                             | `ai-fixable` に貼り替える                                                                                        |
| `/issue-check` が、`issue:decided` の Issue を「方針差し替え」または判定不能と判定した                                                                                                   | `issue:decided` を外す。判定不能なら `needs-human-decision` に移す                                               |
| 人間が、`needs-human-check` の Issue を確かめた                                                                                                                                          | `needs-human-check` を外す                                                                                       |
| Auto-Programmer が、同じ Issue をもう一度 `/auto-dev` に回す                                                                                                                             | 回す直前に `needs-human-check` を外す。前回の印を消しておけば、CI を待つ前に付いている印を今回の離脱と読める     |

## 3択の例外は、専用のラベルで扱いが決まっている Issue に限る

**3択**とは、`ai-fixable`・`needs-human-decision`・`ready-for-human` の3つをいう。起票する Issue には、このうちどれか1つだけを必ず付ける（AI が見つけた問題を `/quick-issue` で起票するときは、加えて `broken-window` を付ける）。どれも付かない Issue は、AI の着手からも、人間の判断や作業からも漏れて、誰の目にも触れなくなる。

例外は、3択のどれも（`broken-window` も）付けない Issue で、**専用のラベルで扱いが決まっているものだけ**である。

- **ルート Issue**（`phase`）：常設で close しない
- **ワークフローが起票する通知の Issue**：`dev-deploy-failure`（`deploy-dev.yml`）と、`pr-ai-triage.yml` が `needs-human-review` で起票する「PR #N の人間レビュー」

これらは専用の経路（常設・自動 close・人間の確認）で扱う。3択を付けると、`/issue-check` や Auto-Programmer（ボードの `Ready` の Issue を1件ずつ拾い、AI に実装させるツール。`scripts/auto-programmer/`）が拾って空回りし、専用の経路と二重に扱われる（#996）。

**umbrella の親は3択の例外にしない。** `/issue-regroup` が立てる子への入口の親も、`/to-issues` のまとめ用の親と同じく `ai-fixable` を付け、`tracking-issue` を重ねる。子が open な間は `/issue-check` が飛ばし、子が全部 close されたら完了条件を見て閉じるので、空回りしない（#996）。親から `ai-fixable` を外さないのは、Auto-Programmer が `ai-fixable` のカードだけを拾い、拾った親の子を Ready に載せて引き継ぐからである。外すと親が拾われず、引き継ぎが止まる。

## ボードの Status の意味

| Status        | 意味                                                         | 誰が動かすか                                                    |
| ------------- | ------------------------------------------------------------ | --------------------------------------------------------------- |
| `Todo`        | ボードに積まれただけで、まだ着手待ちにしていない             | 組み込みワークフロー「Item added to project」                   |
| `Ready`       | 着手してよい。Auto-Programmer はこの Status のカードから拾う | 人間。親から子へ引き継ぐときは Auto-Programmer                  |
| `In progress` | AI か人間が着手した                                          | Auto-Programmer と、AI が着手時に打つ `npm run move-issue-card` |
| `In Review`   | PR が出た（Issue に紐づいた）                                | 組み込みワークフロー「Pull request linked to issue」            |
| `Done`        | 完了した                                                     | 組み込みワークフロー「Item closed」                             |

`In Review` の意味は「CI が通った」ではない。CI の結果でカードを動かす手は2つしかなく、どちらも割に合わないためである（#995）。1つは GitHub Actions に classic の個人アクセストークンを持たせる手、もう1つは AI が CI の結果を見届けてカードを動かす手である。対話では hook が CI を見張るが、起こすのは落ちたときだけで、通った結果は AI に届かない。通ったときも起こすと、通るたびに寝ているセッションを起こすことになり、人間が push した分は見られない。CI が通らなかった Issue は、列ではなく `needs-human-check` で引く（#1000）。

## Issue の階層の形

Issue は GitHub のネイティブ sub-issue で階層にする。sub-issue の親は1件しか持てないので、階層は分解の関係を表すことに使う。例外は最上位のルート Issue だけで、ここだけは分類である。

```text
ルート Issue（常設。使うものは起票先ファイルが決める）
└ 起点 Issue（新規開発ガイドが要件定義書から作る）
  └ スライス Issue（/to-issues が Plan から割る縦スライス）
    └ さらに分割した sub-issue
```

一度張った親子は原則として動かさない。動かしてよいのは1つの場合だけである。**親の open な子が全部ブロッカー待ちになったら**、その子をブロッカーが属する親へ移し、元の親を close する（`/issue-regroup` が行う）。ただし親がルート Issue なら動かさない（ルート Issue は close しないため）。子1件の待ちで親が長く open に残ると、open な Issue の件数が残作業を表さなくなるためである。付け替えると要件へ戻る線が切れる。移す前に子へ「トレース（要件定義書との対応）」節を書き足し、書けない子は移さない。

例：親 #10 の open な子が #11 だけで、#11 のブロッカー #20 が親 #5 の子なら、#11 を #5 へ移して #10 を close する。#11 に「トレース」節を書けなければ、#11 も #10 も動かさない。

## ルート Issue

ルート Issue は、Issue 階層の最上位に置く少数の常設 Issue である。**分解元の親が無い Issue は、すべてルート Issue の sub-issue にする。** 親の無い Issue がボードのトップ階層に並ぶと、Issue が増えるほど一覧が読めなくなるためである。

- **少数の常設 Issue にする**：数を増やすと、トップ階層が読めなくなる元の問題に戻る
- **`phase` ラベルを付けて、探すときもこのラベルを使う**：Issue 番号は使わない（番号はプロジェクトごとに変わるため）
- **close しない**
- **使うルートと振り分け条件は、起票先ファイル（`docs/project-context/issue-destinations.md`）が決める**：プロジェクトごとに起票先が違う（テンプレートには開発準備・結合テストが無い）うえ、プロジェクト固有の値は同期されない場所に置くためである
- **紐付けの手順は `/link-root-issue` が持つ**：ルートの作成・紐付け・世代交代の手順である

振り分け条件は、ラベルや触るパスのように、外から見て分かる事実で書く。「関係がありそう」で選ばせると、AI の判定は必ず甘くなるためである。

### 標準のルート（フェーズ）

製品開発では、開発フローのフェーズを標準のルートとして使える。起票先ファイルに「issue-policy の標準のルートを使う」と書く。名前は次の4つに固定する。

- **要件定義**：要件定義書に関するタスク。未決事項の解消
- **開発準備**：環境構築・技術スタック選定・全体構造設計（アプリアーキテクチャ・ディレクトリ構成）・CI／デプロイ経路の整備
- **設計・実装**：開発系のタスク全般
- **結合テスト**：結合テスト・E2Eテスト

標準のルートを使うときの振り分け条件は、**主に触るもの**で決める。上の行から当て、最初に当たった行で決める。

- `docs/requirements.md`：要件定義
- **開発環境・技術スタック・アプリアーキテクチャ・ディレクトリ構成・`.github/workflows/`**：開発準備
- **`app/`・`infra/` のコードと、その単体テスト**：設計・実装
- **結合テスト・E2Eテストのコードと、その実行環境**：結合テスト
- 上のどれにも当たらない（`.claude/` 配下・`docs/policy/`・`docs/design/`・`docs/guide/` など）：**設計・実装**

判定を**触るもの**で書くのは、触るか触らないかで決まり、重要度の評価を挟まないからである。設計書やポリシーの中でアプリアーキテクチャや結合テストを扱っても、ハーネス・ポリシー・設計書の手直しであることは変わらないので、触るものは `app/`・`infra/` などの実体で見る。

## 親の決め方

次の優先順位で、最初に決まったものを使う。

1. **分解元の Issue があるなら、それが親である。** スライス Issue（`/to-issues` 産）は起点 Issue の子にする。起点 Issue が無いまま `/to-issues` が2件以上を割ったときは、まとめ用の親 Issue を作ってスライス Issue の親にする（作り方は `/to-issues` が持つ）
2. **起点 Issue は、種別でルートが決まる**（新規開発ガイド「起票する起点Issue」の種別表）
3. **分解元の無い Issue——まとめ用の親 Issue、起点 Issue が無い1件だけのスライス Issue、単発 Issue（`/quick-issue` 産）——は、起票先ファイルの条件でルートを決める**

2と3で決まったルートへの紐付けは、`/link-root-issue` が行う。

## 適用範囲

このポリシーは、frontmatter 冒頭の `hook.applies-to` が指すファイル（ラベルを説明・付け外しするもの、ボードの Status を動かすもの、Issue の親子・段番号を説明するもの）を編集する前に自動で差し込まれる。起票・付け替えという行為で発火する分は、各 Skill の手順がこのポリシーを読ませる。

ラベルを説明・付け外しする、ボードの Status を動かす、または Issue の親子・段番号を説明するファイルを新しく作ったら、そのパスを `applies-to` に足す。

## 上位原則との関係

このポリシーは横断原則の具体化である。判断に迷ったら `refined-engineer-judgment-principles` に立ち返る。

- **判断軸は「既定値＋反転条件」で与える**：既定を `ai-fixable` に置き、外れる条件を「人間が決めるべき Issue の条件」と「人間しかできない作業の条件」として列挙する。原則集が NG/OK の例に挙げる「必ずいずれかのラベルを付ける。どれも付いていない状態を許さない」を、3択として定めている
- **割れ窓を放置しない**：`broken-window` は、本筋外の課題を現在の作業に混ぜず、失わないよう別に捕捉するための印である
- **振り分け順**（policy-driven-development-policy「Policy と Rule を分ける線」）：人間が決めるべき Issue の条件は、機械が合否を出せない判断で、「どれを選ぶか」の立場なので Policy に置く。選んだ後の手順・書式は Skill に置く
