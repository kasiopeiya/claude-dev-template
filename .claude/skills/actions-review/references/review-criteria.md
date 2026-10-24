# GitHub Actions workflow レビュー観点

workflow（`.github/workflows/*.yml`）をレビューする AI・人間が、どの観点を見て、何を違反とするか迷ったときに引く観点一覧。

観点ごとに **準拠／違反／対象外**（spec レンズの観点は、これに未判定も使う）を判定し、違反は「severity の決め方」に従って severity 付きの指摘にする。点数は付けない。

> [!IMPORTANT]
> **（AI・必須）** 観点一覧の行は能動的に探す対象＝レビューの背骨である。ここには**機械で合否を出せない判断項目だけ**を載せる。機械で同じ入力に同じ判定を返せる決まりは CI の検査スクリプトに置き、AI の観点にしない。

下の観点一覧の観点は**観点名で識別する**（他ドキュメントからも観点名で参照する）。

## CI の検査で機械的に担保される観点（判定対象外）

次の形は、workflow の検査スクリプトが落とすため、AI の判定から外す（二重に判定しない）。

- **`run:` への式の直接埋め込み**：`${{ github.event.* }}`・`${{ github.head_ref }}` を `run:` に直接書く形。観点「信頼できない入力の扱い」でも見ない
- **Action の SHA 固定**：`uses:` がコミット SHA で固定されているか
- **既定の権限**：workflow の先頭が `permissions: {}` か

## 判定方針

- **違反**：観点の「違反と判定する条件」に当たる箇所を引用できたとき。違反ごとに指摘を1件出し、下の「severity の決め方」で severity を付ける
- **準拠**：その観点を探した結果、条件に当たる箇所が無かったとき。「おそらく問題ない」という印象で付けない
- **対象外**：観点が見る対象がそのファイルに1つも無い場合に使う（例：fork や第三者が起動できるトリガーが無く、外から渡る文字列も扱わない workflow の「信頼できない入力の扱い」）
- **疑わしい場合に違反側へ倒すのは、引用は取れるが解釈が分かれるときだけ**（spec レンズの観点を除く。下の読み替えに従う）。その場合は指摘に「解釈が分かれる（引用箇所を〇〇と読むなら違反）」と明記する。引用そのものが取れない「確認が取れない」は違反にしない
- **spec レンズの観点**：実在・発火経路・権限・提供範囲の判定は、下の「spec レンズの判定」に従う

## 観点一覧

| 観点                       | チェック内容                                                                                                                                                                                                                               | 違反と判定する条件                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **信頼できない入力の扱い** | `pull_request_target` など fork や第三者が起動できるトリガーで、secret や書き込み権限に届かないか。外から渡った文字列（PR のタイトル・ブランチ名など）が、step の出力や env を経て、コードとして動かないか                                 | 第三者が用意したコード・文字列が、secret・書き込み権限を持つ job で実行されうる。または外から渡った文字列が `eval`・スクリプトへの連結などでコードとして解釈される |
| **job ごとの権限**         | job に付けた `permissions` が、その job の処理に要るものだけか                                                                                                                                                                             | job の step が使わない権限が付いている（例：書き込みをしない job の `contents: write`）                                                                            |
| **実在**                   | 新しい組（下の「spec レンズの対象」）が、その組の提供元の公式資料（GitHub の仕様は docs.github.com、`uses:` の Action はそのリポジトリの README・`action.yml`、`gh` は公式マニュアルと REST API の仕様）に、書かれたとおりの形で存在するか | 提供元の公式資料の該当ページに、その名前が載っていない、または別の形で載っていると、一次資料で示せる                                                               |
| **発火経路**               | 新しいトリガーが、このリポジトリで実際にそのイベントを起こす経路（`GITHUB_TOKEN` によるマージ・Issue の操作、fork の PR など）で起動するか。トリガー以外の組には当てない                                                                   | そのイベントを起こす経路をすべて挙げたとき、新しいトリガーが起動しない経路が1つでもあると、一次資料で示せる（起動しない経路を指摘に書く）                          |
| **権限・提供範囲**         | 新しい呼び出し（`gh` のサブコマンド・`gh api`・`uses:` の Action）に要る権限を、使う token が持っているか。プラン・Enterprise・組織の設定で使えなくならないか。トリガー・`permissions:` のスコープの組には当てない                         | 要る権限を token が持たない、またはプラン・Enterprise・組織の設定で使えないと、一次資料で示せる                                                                    |

### spec レンズの対象

spec レンズは、差分で新しく出た（種類, 名前）の組だけを調べる。組の種類は次の4つで、同じ文字列でも種類が違えば別の組として扱う（例：権限の `issues` と、トリガーの `issues`）。

- **トリガー**：`on:` 直下のイベント名。activity types とフィルタのキーは、イベント名とつなげて1つの名前にする（例：`issues` の `closed`、`push` の `branches`。`branches:` に並べたブランチ名のような値は含めない）
- **`permissions:` のスコープ**：スコープ名だけで、`read`・`write` の別は含めない（例：`issues`）
- **`uses:` の Action**：`owner/repo` だけで、`@` 以降は含めない（例：`actions/checkout`）
- **`run:` の中の `gh`**：コマンドとサブコマンドまでで、フラグは含めない（例：`gh issue close`）。`gh api` は、メソッドとパスで書き、パスの変数の部分は REST API の仕様にあるパラメータ名を `{}` で囲んで書く（例：`POST /repos/{owner}/{repo}/issues/{issue_number}/labels`）。`-X` が無いときのメソッドは、GET（`-f`・`-F`・`--input` があれば POST）とする

新しい組の決め方と取り出し方は、SKILL.md「Phase 2」に置く。対象の組すべてに観点「実在」を当てる。観点「発火経路」「権限・提供範囲」を当てる組は、観点一覧の各行が決める。

### spec レンズの判定

- **未確認**：一次資料を読んでも確かめきれなかった項目（例：Enterprise での挙動が書かれていない。原文は引けても読みが2通りに分かれる場合も含む）は、「解釈が分かれる」を使わず、違反にも準拠にも数えず、「未確認」として別に報告する。ただし、載るはずのページを開いて組の名前が載っていないことを確かめたなら、実在の違反であって未確認ではない
- **観点の行の判定**：その観点を当てる組のうち、違反の組が1つでもあれば**違反**、違反が無く確かめられた組が1つ以上あれば**準拠**、組がすべて未確認なら**未判定**（理由は「未確認」欄に書く）とする
- **対象外**：spec レンズが起動しなかったとき（新しい組が無い）と、その観点を当てる組が無いとき（例：トリガーが新しくない差分の「発火経路」）に使う
- **違反にする根拠の規則**：[agent 定義](../../../agents/actions-reviewer-agent/actions-reviewer-agent.md)の「spec レンズの手順」に置く

### Critical の例

- **信頼できない入力の扱い**
  - `pull_request_target` で起動する job が、PR の head（`github.event.pull_request.head.sha` など）を checkout し、そのコードを secret を env に渡した状態で実行する
  - `workflow_run` で起動する job が、fork の PR が作った artifact を取り込み、中のスクリプトを実行する
  - PR のタイトルを step の出力に入れ、後の step が `eval "$TITLE"` やシェル文字列への連結で実行する
- **job ごとの権限**
  - fork や第三者が起動できるトリガーの job に、処理に要らない `contents: write`・`pull-requests: write`・`id-token: write`、または `write-all` が付いている
- **実在**
  - `pull_request` の `types:` に `merged` を書く（公式の activity types に無い。マージの判定は `closed` と `github.event.pull_request.merged` で行う）
- **発火経路**
  - `GITHUB_TOKEN` で Issue を閉じる別の workflow が起こす `issues` の `closed` で動く workflow を足す（`GITHUB_TOKEN` の操作が起こしたイベントは、`workflow_dispatch` と `repository_dispatch` を除き、新しい workflow を起動しない）
- **権限・提供範囲**
  - `GITHUB_TOKEN` で Projects のカードを動かす `gh project` の step を足す（`GITHUB_TOKEN` では Projects を操作できないと一次資料に書かれているとき）
  - Free の組織の private リポジトリで、ブランチへの push 制限（Restrict who can push to matching branches）を設定する step を足す（公式に「public repositories owned by a GitHub Free organization and in all repositories owned by an organization using GitHub Team or GitHub Enterprise Cloud」で有効にできるとあるとき）

## severity の決め方

重大度（Critical / High / Medium）の定義は [ai-review-gate-policy](../../../../docs/policy/ai-review-gate-policy.md) が正典。観点によって分け方が違う。

### 実在／発火経路／権限・提供範囲

**観点一覧の「違反と判定する条件」に当たると一次資料で示せたもの（公式に記載が無い・別の形で載っている・実際の経路で起動しない・権限が足りない・プランや設定で使えない）は Critical にする**。書かれたとおりに動かない workflow は、マージされても何も起こさないか、実行時に落ちるためである。

### 信頼できない入力の扱い／job ごとの権限

違反した job を**第三者が起動できるか**で Critical と High を分ける。この2観点の違反はどれも secret・権限に関わるので、Medium にはしない。

- **Critical**：第三者が起動できる job での違反（上の「Critical の例」）
- **High**：第三者が起動できない job での違反。いまは第三者が届かないが、トリガーを足したときに届く（例：`push` で起動する job に要らない `write-all` が付いている）

第三者が起動できる job かは、次で決める。

- **起動できる**：`pull_request_target`・`workflow_run`・`issue_comment`・`issues` など、fork や第三者の操作で起動し、secret や書き込み権限を受け取れるトリガーの job
- **起動できない**：`push`・`workflow_dispatch`・`schedule` の job。`pull_request` の job（fork からの実行には secret が渡らず、token も読み取り専用になる）。`if:` で fork からの実行を外した job（例：`github.event.pull_request.head.repo.full_name == github.repository`）
