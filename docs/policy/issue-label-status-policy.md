---
hook:
  applies-to:
    [
      'scripts/setup-labels.sh',
      'scripts/auto-programmer/**/*.mjs',
      'scripts/auto-programmer/README.md',
      'scripts/doc-consistency-weekly-issue.mjs',
      'scripts/code-policy-weekly-issue.mjs',
      '.github/workflows/pr-ai-triage.yml',
      '.github/workflows/deploy-dev.yml',
      '.github/workflows/close-human-review-issue.yml',
      '.claude/agents/issue-auditor-agent/*.md',
      '.claude/skills/quick-issue/**/*.md',
      '.claude/skills/to-issues/**/*.md',
      '.claude/skills/issue-check/**/*.md',
      '.claude/skills/issue-split/**/*.md',
      '.claude/skills/issue-decide/**/*.md',
      '.claude/skills/issue-regroup/**/*.md',
      '.claude/skills/issue-deps/**/*.md',
      '.claude/skills/sweep/**/*.md',
      '.claude/skills/doc-consistency/**/*.md',
      '.claude/skills/sre-prr/**/*.md',
      '.claude/skills/auto-dev/**/*.md',
      '.claude/skills/auto-fix-ci/**/*.md',
      '.claude/skills/design/SKILL.md',
      '.claude/skills/code-review/**/*.md',
      '.claude/skills/doc-review/**/*.md',
      '.claude/skills/cdk-review/**/*.md',
      '.claude/skills/arch-review/**/*.md',
      '.claude/skills/requirements-review/**/*.md',
      'docs/policy/review-subagent-lens-policy.md',
      'docs/reference/issue-hierarchy.md',
      'docs/guide/development-flow.md',
      'docs/guide/new-development-guide.md'
    ]
---

# Issue ラベル・ボード Status ポリシー

AIエージェントが、Issue を起票する・Issue のラベルを付け替える・ボードの Status を動かす・ラベルや Status の規則を説明する文書を書くときに参照する。ラベルの規則を Skill ごとに持つと、変えるたびにどこを直せば全体が変わるのか分からなくなり、直し漏れで判断が食い違う（#996）。

> [!IMPORTANT]
> **TL;DR（このポリシーの決定事項）**
>
> - **Issue ラベルの意味・付ける条件・移し先と、ボード Status の意味は、このポリシーだけが持つ。** Skill・SubAgent・Policy は条件を書き写さず、このポリシーの節を名指しで読む
> - **既定は `ai-fixable`。名指し例外に当たるときだけ `issue:needs-human-decision` にする。** どちらか一方を必ず付け、どちらも付けない Issue は作らない。ただし、専用のラベルで扱いが決まっている Issue だけは、「3択の例外」として付けない（定義は下の「3択の例外」の節）
> - **手順・書式・状態図はこのポリシーに置かない。** 選んだ後の How は各 Skill が持つ（ADR-014）

## このポリシーが決めること

| このポリシーが決める                             | 決めない（置き場所）                                                             |
| ------------------------------------------------ | -------------------------------------------------------------------------------- |
| Issue ラベルの意味・付ける条件・移し先           | ラベルを付ける手順・本文の書式（`/quick-issue` など各 Skill）                    |
| 名指し例外の条件と、`issue:decided` を付ける条件 | 「人間が決めた名指し例外」の行の形（`/quick-issue`）                             |
| 3択の例外（どちらも付けない Issue）              | 状態の遷移を示す図（`/issue-decide`）                                            |
| ボードの Status の意味                           | Status を動かす手順と、ボードの表記の設定（`scripts/auto-programmer/README.md`） |
| —                                                | PR のラベル（`pr-review-policy.md`「PRラベルと変更の種類」表）                   |

例外名を挙げて参照するのは、書き写しではない。条件の文を写すのが書き写しである。

- ❌ レビュー系 Skill に「どちらを採っても要件・プロダクトの方針が変わるとき」と条件の文を写す → ✅ 名指し例外「要件／プロダクト方針が変わる」と名前で参照し、このポリシーの節名「名指し例外は、人間が決めるべき Issue の条件である」を書く

## Issue に付けるラベル

| ラベル                                         | 意味                                                                                    | 付ける条件                                                                                                          |
| ---------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `ai-fixable`                                   | 中身を見ずに AI が直せる。AI が着手する対象を選ぶ印                                     | 名指し例外に当たらないとき（既定）。当たっても人間が決めた例外なら、`issue:decided` を重ねて付ける                  |
| `issue:needs-human-decision`                   | 中身を見ずには直せない。人間が1件ずつ方針を決める対象を選ぶ印                           | 名指し例外のいずれかに当たり、人間がまだ決めていないとき                                                            |
| `issue:decided`                                | 人間が、当たる名指し例外を承知で方針を決めた                                            | 「人間が決めた例外」の条件を満たすとき。`ai-fixable` にだけ重ねる                                                   |
| `issue:checked`                                | `/issue-check` が一度監査した。いま妥当である保証ではない                               | `/issue-check` が判定を出した Issue に、判定が何であれ貼る。監査できなかった・飛ばした Issue には貼らない           |
| `boy-scout`                                    | 正式フロー（`/to-issues` など）を経ずに積んだ課題。後で棚卸しする                       | `/quick-issue` が無条件で付ける。`/to-issues`・`/issue-split` が作る Issue には付けない                             |
| `policy-gap`                                   | 判定時に該当ポリシー・rules が見つからなかった。ポリシーを足す候補                      | 該当ポリシー・rules を探して見つからなかったとき。`ai-fixable`・`issue:needs-human-decision` のどちらにも重ねてよい |
| `issue:needs-clean-session`                    | 着手したうえで、このやり方では直しきれないと分かった。専用のセッションで1件だけ対応する | `/sweep`・`/auto-dev`・`/auto-fix-ci` が着手後に離脱するとき。起票時には付けない。`ai-fixable` は外さない           |
| `phase`                                        | Issue 階層の最上位。開発フローのフェーズを表す常設 Issue                                | フェーズ Issue にだけ付ける（3択の例外）                                                                            |
| `requirement`                                  | 要件定義書のレビュー指摘に起因する Issue                                                | `/requirements-review` が起票するとき、ほかのラベルに重ねる                                                         |
| `doc-consistency-weekly`・`code-policy-weekly` | 週次ワークフローが起票した Issue を見分ける専用の印                                     | 週次スクリプトが `ai-fixable` と一緒に付ける。ラベルの当否は、着手前の `/issue-check` が見る                        |
| `dev-deploy-failure`                           | dev への deploy が失敗した通知の Issue                                                  | `deploy-dev.yml` が起票するとき（3択の例外）                                                                        |

PR に付く `needs-human-review` などのラベルの意味は `pr-review-policy.md` が持つ。このポリシーが扱うのは、そのラベルを付けて起票される通知の Issue（下の「3択の例外」）だけである。

## 名指し例外は、人間が決めるべき Issue の条件である

名指し例外は、着手してみないと何をするか決まらない Issue を、外形的な条件で挙げたものである。`ai-fixable` は中身を見ずに AI へ流す対象を選ぶラベルなので、そうした Issue には付けられない。条文の移し元は `/quick-issue`「どちらを付けるか」である（#996）。

**既定は `ai-fixable`** である。次の例外に当たるときだけ `issue:needs-human-decision` に切り替える（人間が会話で決めた例外は除く。下の「人間が決めた例外は `issue:decided` で通す」）。どちらも付けない選択肢は無い（3択の例外を除く）。例外に当たるかどうか迷ったら `issue:needs-human-decision` を付ける。ただし「外部依存の制約を受けて…」の例外だけは、確実と言い切れないなら当たらない。

- **不可逆・外部に出る**：ファイル削除・公開・本番操作・外部サービス設定
- **要件／プロダクト方針が変わる**：「何を作るか」に触れる
- **ポリシー同士が正面衝突している**：どちらを優先するかの裁定が要る
- **比較に実測が要り、その手段が今ない**：性能・コストのトレードオフ
- **恒久的に保守が要る資産を新設する**：新規スクリプト・hook・CI ジョブ・外部依存の追加
- **書くべき設計書がまだ無い**：内容の書き先のどれにも当たらない。書き先の一覧と、上から当てる手順は、`/quick-issue` の `destination-rules` が持つ
- **着手前に仕様を詰める対話が要る**：`/grill-me` で詰めてから sub-issue に割る親Issue（新規開発ガイドの起点Issue）
- **外部依存の制約を受けて、計画や対応方針を見直すかを決める**：`/issue-check` が、本文にまだ示していない外部の製品・サービスの制約のうち、対応方針を確実に実行できなくするものを、一次資料で見つけた Issue。確実かどうかの見分け方（手順）は、`/issue-check` の「外部依存の前提の報告を判定に変える」が持つ

「恒久的に保守が要る資産」の例外は**新設**にだけ効く。新しいスクリプト・hook・CI ジョブ・外部依存を足すなら、既存の `package.json` やワークフローへの追記でも当たる。新しい資産を増やさない変更（既存ファイルの編集・ドキュメント／ポリシーの改訂・既存設定へのルール追加）は当たらない。足した仕組みは以後ずっと保守が要るので、増やすかどうかは人間が決める（[refined-engineer-judgment-principles](refined-engineer-judgment-principles.md)「YAGNI——必要になるまで作らない」のコードは負債）。

**「案が2つ以上ある」ことは `issue:needs-human-decision` の理由にならない。** 推奨案が立つなら、その根拠と却下案を「対応方針」に書いて `ai-fixable` を付ける。ポリシーが裁定できる問いを人間に戻すと、AI に判断を委譲する仕組みが成立しない（CLAUDE.md「原則から明確に答えが出るなら AI が自分で決めてよい」）。

| 例                                                           | ラベル                        | なぜ                                 |
| ------------------------------------------------------------ | ----------------------------- | ------------------------------------ |
| タイポ・表記ゆれ                                             | `ai-fixable`                  | 例外に当たらない                     |
| 新しい判断基準をどの文書に置くか                             | `ai-fixable`                  | 案は複数だがポリシーが裁定できる     |
| 既存の静的解析設定にルールを1つ足す                          | `ai-fixable`                  | 既存の仕組みの手直しで、新設ではない |
| 画面に CSV 出力を足す                                        | `issue:needs-human-decision`  | 何を作るかが変わる                   |
| 内部の関数を、振る舞いを変えずに分割する                     | `ai-fixable`                  | 何を作るかは変わらない               |
| 参照先の実在を検証するスクリプトと CI ジョブを新設する       | `issue:needs-human-decision`  | 恒久的に保守が要る資産の新設である   |
| 上と同じ新設を、スクリプト名とジョブ名を示して人間が承認した | `ai-fixable`＋`issue:decided` | 当たる例外を人間が決めている         |
| ポリシーAとBが逆のことを言っている                           | `issue:needs-human-decision`  | ポリシー同士が正面衝突している       |
| 使わなくなったディレクトリを消すか                           | `issue:needs-human-decision`  | 不可逆である                         |
| 画像アップロードの仕様を書く設計書がまだ1件も無い            | `issue:needs-human-decision`  | 書くべき設計書がまだ無い             |

## 人間が決めた例外は `issue:decided` で通す

当たる名指し例外の**すべて**について、人間がその論点を決めた発言を会話から引用できるなら、`ai-fixable` に `issue:decided` を重ねる。1つでも引用できなければ `issue:needs-human-decision` にする。名指し例外のねらいは人間が決めることで、決めた発言があればそれは果たされている。

引用できる発言は、その例外が人間に何を問うかで違う。

- **するかしないかを問う例外**（例：不可逆・外部に出る、恒久的に保守が要る資産を新設する）：対象を具体名で示し（例：`scripts/x.mjs` とその単体テスト、`docs/old/` の削除）、人間が承認した発言。具体名で示していない物は、決めていない扱いにする。人間が見ていない物まで通さないためである
- **裁定や中身を問う例外**（例：ポリシー同士が正面衝突している、書くべき設計書がまだ無い）：人間が裁定や中身そのものを述べた発言。「進めてよい」だけでは足りない

決めた例外は、「対応方針」に1例外1行で書く（行の形は `/quick-issue`）。`issue:decided` が通すのは、この行に書いた例外だけである。`/issue-check` が差し戻しの理由から何を外すかの細部は、`/issue-check` の監査基準が持つ。

## ラベルの移し先

| 場面                                                                                                                                              | 移し先                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `/issue-decide` で、人間が当たる名指し例外の論点を決めた                                                                                          | `issue:needs-human-decision` を外し、`ai-fixable` と `issue:decided` を付ける |
| `/issue-check` が、`ai-fixable` の Issue は名指し例外に当たると判定した（`issue:decided` 付きなら、「対応方針」に行の無い例外に当たると判定した） | `issue:needs-human-decision` に貼り替える。`issue:decided` が付いていれば外す |
| `/issue-check` が、`issue:needs-human-decision` の Issue は名指し例外に当たらないと判定した                                                       | `ai-fixable` に貼り替える                                                     |
| `/issue-check` が、`issue:decided` の Issue を「方針差し替え」または判定不能と判定した                                                            | `issue:decided` を外す。判定不能なら `issue:needs-human-decision` に移す      |

## 3択の例外は、専用のラベルで扱いが決まっている Issue に限る

**3択**とは、`boy-scout`・`ai-fixable`・`issue:needs-human-decision` の3つをいう。起票する Issue には、このうち `ai-fixable` か `issue:needs-human-decision` のどちらか一方を必ず付ける（`/quick-issue` は加えて `boy-scout` を付ける）。どれも付かない Issue は、一斉対応からも個別相談からも漏れて、誰の目にも触れなくなる。

例外は、3つのどれも付けない Issue で、**専用のラベルで扱いが決まっているものだけ**である。

- **フェーズ Issue**（`phase`）：常設で close しない
- **ワークフローが起票する通知の Issue**：`dev-deploy-failure`（`deploy-dev.yml`）と、`pr-ai-triage.yml` が `needs-human-review` で起票する「PR #N の人間レビュー」

これらは専用の経路（常設・自動 close・人間の確認）で扱う。3択を付けると、`/issue-check` や Auto-Programmer（ボードの `Ready` の Issue を1件ずつ拾い、AI に実装させるツール。`scripts/auto-programmer/`）が拾って空回りし、専用の経路と二重に扱われる（#996）。

**umbrella の親は3択の例外にしない。** `/issue-regroup` が立てる子への入口の親も、`/to-issues` のまとめ用の親と同じく `ai-fixable` を付ける。子が open な間は `/issue-check` が飛ばし、子が全部 close されたら完了条件を見て閉じるので、空回りしない（#996）。

## ボードの Status の意味

| Status        | 意味                                                         |
| ------------- | ------------------------------------------------------------ |
| `Todo`        | ボードに積まれただけで、まだ着手待ちにしていない             |
| `Ready`       | 着手してよい。Auto-Programmer はこの Status のカードから拾う |
| `In progress` | 着手中                                                       |
| `In Review`   | CI が通り、人間がレビューしてよい                            |
| `Done`        | 完了した                                                     |

## 適用範囲

このポリシーは、frontmatter 冒頭の `hook.applies-to` が指すファイル（ラベルを説明・付け外しするもの、ボードの Status を動かすもの）を編集する前に自動で差し込まれる。起票・付け替えという行為で発火する分は、各 Skill の手順がこのポリシーを読ませる。

ラベルを説明・付け外しする、またはボードの Status を動かすファイルを新しく作ったら、そのパスを `applies-to` に足す。

## 上位原則との関係

このポリシーは横断原則の具体化である。判断に迷ったら `refined-engineer-judgment-principles` に立ち返る。

- **判断軸は「既定値＋反転条件」で与える**：既定を `ai-fixable` に置き、外れる条件を名指し例外として外形的に列挙する。原則集が NG/OK の例に挙げる「必ずいずれかのラベルを付ける。どれも付いていない状態を許さない」を、3択として定めている
- **割れ窓を放置しない**：`boy-scout` は、本筋外の課題を現在の作業に混ぜず、失わないよう別に捕捉するための印である
- **振り分け順**（[policy-driven-development-policy](policy-driven-development-policy.md)「Policy と Rule を分ける線」）：名指し例外は機械が合否を出せない判断で、「どれを選ぶか」の立場なので Policy に置く。選んだ後の手順・書式は Skill に置く
