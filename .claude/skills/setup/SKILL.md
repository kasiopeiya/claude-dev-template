---
name: setup
description: テンプレートから作ったリポジトリの立ち上げを、1コマンドで進める。GitHub の設定を変え、ファイルを消すので、人間が `/setup` と打ったときだけ動く。
disable-model-invocation: true
---

# /setup

立ち上げの手順の正はこの Skill である。

## この Skill で使う語

- **`/setup` の変更**：各手順が書き換えるパス（`docs/adr/`）のうち、`git status --porcelain -- docs/adr/` に出るもの。前回の `/setup` が書き換えて、まだコミットしていない変更も含む（途中で止まって流し直しても、取りこぼさないため）
- **立ち上げの Issue**：`/setup` の変更をリポジトリへ入れる Issue。タイトルに目印の語「立ち上げの準備をリポジトリへ入れる」を含む。次で探す

  ```bash
  gh issue list --state all --limit 100 --search '立ち上げの準備をリポジトリへ入れる in:title' --json number,title,state --jq '.[] | select(.title | contains("立ち上げの準備をリポジトリへ入れる"))'
  ```

- **手作業の Issue**：人間の手作業が済まなかったときに起票する Issue。タイトルに「/setup の手作業：<手順の見出し>」を含む（例：「/setup の手作業：リポジトリ設定を入れる」）。次で探す

  ```bash
  gh issue list --state open --label ready-for-human --limit 100 --search '"/setup の手作業" in:title' --json number,title --jq '.[] | select(.title | contains("/setup の手作業：<手順の見出し>"))'
  ```

## すべての手順に効く決まり

- **済んだ手順は飛ばす**：各手順は、まず済んでいるかを確かめ、済んでいれば飛ばす。途中で止まっても、もう一度 `/setup` を流せば続きから進む。何度流しても同じ結果になるスクリプトを流す手順（「ラベルを作る」「リポジトリ設定を入れる」）は、確かめをスクリプトに任せる
- **人間の手作業は、済まなければ Issue にして進む**：人間にしかできない作業は、何をするかを案内し、`AskUserQuestion` で済ませたかを聞く。済ませたなら確かめ直して次へ進む。その場で済まなければ、手作業の Issue を `/quick-issue` で起票し、次の手順へ進む。ラベルは `ready-for-human` にし、人間のタスクの頭に「（人間）」と書く。同じ手順の手作業の Issue が open で残っていれば、起票し直さない。例外は次の2つで、どちらも Issue にせずに止める
  - 「ラベルを作る」が済むまでの手作業が済まなかった：gh かラベルが無く、Issue を起票できない
  - テンプレート本体のリポジトリで流された：手作業として聞かずに止める（続けると、本体の ADR や設定を消す）
- **変更は、立ち上げの Issue の PR で入れる**：手順が書き換えたファイルは、その場でコミットしない。最後に「立ち上げの Issue を起票する」と「ブランチでコミットして push する」が、まとめてリポジトリへ入れる

## 手順

上から順に進める。

### 前提を確かめる

1. gh が使えるかと、どのリポジトリで流されたかを確かめる。テンプレート本体の場所は `scripts/sync-template.sh` の `TEMPLATE_URL` から引く。

   ```bash
   template=$(sed -n "s/^readonly TEMPLATE_URL='\(.*\)'$/\1/p" scripts/sync-template.sh) && { test -n "$template" || { echo 'scripts/sync-template.sh から TEMPLATE_URL を引けない' >&2; false; }; } && origin=$(git remote get-url origin) && gh repo view "$template" --json nameWithOwner --jq .nameWithOwner && gh repo view "$origin" --json nameWithOwner --jq .nameWithOwner
   ```

   - **失敗した**：gh が無い・未認証・origin が無い・`TEMPLATE_URL` を引けない、のどれか。エラーを見せ、人間の手作業として扱う（gh を入れる・`gh auth login` する・自分のリポジトリを origin に足す・`scripts/sync-template.sh` の `readonly TEMPLATE_URL='…'` の行をテンプレートの形に戻す）。認証は `gh auth status` で確かめない（どれか1つのホストのトークンが切れているだけで失敗する）
   - **2行が同じ**：テンプレート本体のリポジトリである。何もせずに止め、自分のリポジトリを作って origin をそこへ向けてから流し直すよう案内する

2. `node_modules` が無ければ `npm ci` を流す。「テンプレートの ADR を消す」の `npm run gen:adr-index` と、コミット時の git hook が prettier を使う

### ラベルを作る

`./scripts/setup-labels.sh` を流す。

失敗したら、エラーを見せ、人間の手作業として扱う。

### リポジトリ設定を入れる

`./scripts/setup-repo-settings.sh` を流す。最初の push で PR が作られ、CI が動くための設定を入れる。

終了コードが 1 なら、「失敗した」と表示された段を人間の手作業として扱う（管理者権限・組織の設定・プランの制約など、AI には直せない原因のため）。直し方は各段のエラーに添えてある。確かめ直すときは、スクリプトを流し直す。

### テンプレートの ADR を消す

テンプレートの ADR（`docs/adr/` の `NNN-*.md`）を消し、一覧を作り直す。残すと、テンプレートのハーネスについての ADR が、自分のプロジェクトの一覧に混ざり続ける（`docs/adr/` はテンプレート同期の対象外なので、一度消せば戻らない）。

次のどちらかなら飛ばす。

- **close 済みの立ち上げの Issue がある**：テンプレートの ADR は、その Issue の PR で消えている。いま `docs/adr/` にある ADR は、自分のプロジェクトが書いたものである
- **`docs/adr/` に `NNN-*.md` が無い**

飛ばさないなら、消すファイルを表示しながら消し、一覧を作り直す。`adr-template.md` と `adr-index.md` は消さない。

```bash
find docs/adr -maxdepth 1 -name '[0-9][0-9][0-9]-*.md' -print -delete && npm run gen:adr-index
```

### 立ち上げの Issue を起票する

立ち上げの Issue を探し、次で分ける。

- **open のものがある**：それを使う
- **open のものが無く、`/setup` の変更がある**：`/quick-issue` で起票する。ラベルとルート Issue への紐付けは `/quick-issue` の決まりに従う
- **open のものが無く、`/setup` の変更も無い**：リポジトリへ入れる変更が無い。この手順と「ブランチでコミットして push する」を飛ばす

起票する Issue には次を書く。

- **タイトル**：立ち上げの Issue の目印の語を含める
- **対応方針**：`/setup` の変更を、ブランチと PR でリポジトリへ入れる
- **タスク一覧**：`/setup` の変更の内容を1つずつ並べ、済んだものにチェックを入れる
- **ラベル**：`ai-fixable`。`/setup` の変更にテンプレートの ADR の削除があるなら、「不可逆・外部に出る」に当たるので `issue:decided` を重ね、人間の発言には「/setup」と書く
- **実装フロー（使用するSkill）**：該当なし（`/setup` が直接編集した）

### ブランチでコミットして push する

立ち上げの Issue の番号を `<番号>` とする。

1. 立ち上げのブランチ `chore/issue-<番号>` に移る。ローカルにあれば `git switch chore/issue-<番号>` で移る。無ければ、デフォルトブランチの最新から作る。デフォルトブランチ名は、origin を名指しして GitHub から引く（upstream など別の remote と取り違えない）。シェル変数は Bash ツールの呼び出しをまたいで残らないので、1回で実行する。

   ```bash
   base=$(gh repo view "$(git remote get-url origin)" --json defaultBranchRef --jq .defaultBranchRef.name) && git fetch origin "$base" && git switch -c chore/issue-<番号> --no-track "origin/$base"
   ```

   git が「Your local changes ... would be overwritten」で断ったら、人間の未コミットの変更と重なっている。メッセージを見せ、人間の手作業（コミットか stash で片付ける）として扱う。済まなければ、この手順の残りを飛ばす

2. `/setup` の変更だけを `git add <パス>` でステージし、`/git-commit stage` でコミットする。ワーキングツリー全体はステージしない（人間の作業中の変更を混ぜないため）。`/setup` の変更が無ければ（前回の `/setup` でコミット済みなど）飛ばす
3. push の前に、デフォルトブランチの最新を取り込む。`npm run gen:adr-index` で差分が出たら、`git add docs/adr/adr-index.md` して `/git-commit stage` でコミットする

   ```bash
   base=$(gh repo view "$(git remote get-url origin)" --json defaultBranchRef --jq .defaultBranchRef.name) && git fetch origin "$base" && git merge --no-edit "origin/$base" && npm run gen:adr-index
   ```

4. `git push -u origin HEAD` で push し、`/pr-body <番号>` を流す。`/pr-body` が「PR が現れない」で止まったら、PR を作る `pipeline.yml` の実行を引き、落ちたジョブのログを見る。

   ```bash
   gh run list --workflow pipeline.yml --branch chore/issue-<番号> --limit 1 --json databaseId,url --jq '.[] | "\(.databaseId) \(.url)"'
   gh run view <run ID> --log-failed
   ```

   - **`create-pull-request` ジョブが `GitHub Actions is not permitted to create or approve pull requests` で落ちた**：Actions に PR の作成が許されていない。人間の手作業として扱う（Settings → Actions → General の Workflow permissions で、Actions に PR の作成と承認を許す。組織所有なら組織の設定も）。確かめ直すときは、`./scripts/setup-repo-settings.sh` を流し、`gh run rerun <run ID> --failed` で落ちたジョブを流し直してから、`/pr-body <番号>` をもう一度流す
   - **ほかの原因**：エラーと実行の URL を報告に載せ、「次にやることを案内する」へ進む

### 次にやることを案内する

次を人間に伝える。

- 新規に立ち上げるなら、[新規開発ガイド](../../../docs/guide/new-development-guide.md) に従い、要件定義から始める
- 要件定義書（`docs/requirements.md`）と設計書（`docs/design/`）は、空から書く
- 実装は `app/`・`infra/` に書く。どちらも空なので、`samples/` の参照実装を手本にして写す（`samples/` 自体は書き換えない）

あわせて、手順ごとの結果（済ませた／済んでいたので飛ばした／Issue にした番号）を報告する。PR を作ったなら、その URL も添える。
