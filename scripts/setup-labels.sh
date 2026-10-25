#!/usr/bin/env bash
# 責務: Issue ベースの開発フロー（Skill・workflow）が前提とするラベルを、対象リポジトリへ一括で作る。
#   ラベルが無いと `gh issue create --label` や `gh issue edit --add-label` が失敗するため、
#   使い始めに1回流して失敗の元を無くす（Issue #945）。
#
#   無いラベルだけ作り、既存のラベルは上書きしない。利用先が色や説明を変えていても壊さず、
#   何度流しても同じ結果になる。
#
#   ラベルを足す・変えるときは、下の LABELS を直す（定義はここ1か所）。ラベルの意味と付ける条件は
#   docs/policy/issue-policy.md が正で、LABELS の説明はその要約である。Skill と workflow が
#   失敗時や実行時に個別に作る処理（`/quick-issue` など）は、このスクリプトを流していない
#   利用先への保険として残してある。
#
# 実行方法・前提は `./scripts/setup-labels.sh --help` を見ること
# （説明の正は下の usage()。ここに二重に書かない）。

set -euo pipefail

# 「名前|色(# なし)|説明」。色と説明は、テンプレートのリポジトリの現行値に合わせる。
readonly LABELS=(
  # Issue: /quick-issue・/issue-check・/auto-dev・Auto-Programmer などが付ける
  'broken-window|C2E0C6|AI が作業中に見つけ、その場で直さずに起票した問題'
  'ai-fixable|0E8A16|問題と対応方針が一意に定まり、AIが単独で対応できるIssue'
  'needs-human-decision|0052cc|中身を見ずには直せない。人間が1件ずつ方針を決める対象を選ぶ印'
  'ready-for-human|FBCA04|方針は決まっているが、残る作業を AI が実行する手段を持たない Issue'
  'issue:decided|1D76DB|人間が方針を決めた Issue。決めた条件を理由に人間判断へ戻さない'
  'harness|BFDADC|ハーネス（Policy・Rule・Skill・SubAgent・hooks）を変えるIssue'
  'tracking-issue|D4C5F9|子を持つ親 Issue。自分では実装せず、子に分けて進める単位'
  'issue:checked|BFD4F2|/issue-check が一度監査した Issue。いま妥当である保証ではない'
  'needs-human-check|F9D0C4|無人実行が問題で止まったIssue。人間が確かめたら外す'
  'phase|0E4B99|Issue階層の最上位の常設Issue（起票先）'
  'requirement|1D76DB|要件定義書のレビュー指摘に起因するIssue'
  # PR: docs/policy/pr-review-policy.md の「PRラベルと変更の種類」表と /pr-label が付ける
  'feature|0075ca|新機能・機能変更（振る舞いの変更を含む）'
  'cicd|5319e7|.github配下・CI・静的解析などの変更'
  'bug|d73a4a|Something isn'"'"'t working'
  'refactor|fbca04|振る舞いを変えない構造の変更'
  'chore|cfd3d7|設定変更・依存関係更新など'
  'docs|0e8a16|ドキュメント変更'
  'policy|D93F0B|判断基準の変更'
  'needs-human-review|d93f0b|人間がレビューすべきPR'
  'needs-manual-triage|e99695|レビュー要否を自動判定できなかった。人間が分類すること'
  # workflow: 実行時にも自己作成するが、初回の権限差を気にしなくて済むよう先に作っておく
  'doc-consistency-weekly|5319E7|週次の docs/ 横断整合性チェック Issue'
  'code-policy-weekly|B60205|週次のコード Policy 準拠チェック Issue'
  'dev-deploy-failure|B60205|dev への deploy が失敗した'
)

usage() {
  cat <<'HELP'
使い方:
  ./scripts/setup-labels.sh          必要なラベルのうち、無いものだけを作る
  ./scripts/setup-labels.sh --help   この使い方を表示する

前提:
  gh（GitHub CLI）が入っていて、`gh auth login` 済みであること。
  対象は、カレントの git リポジトリを gh が指すリポジトリ（実行時に表示する）。
  どちらかが欠けていれば、何も作らずエラー終了する。

動作:
  既存のラベルは上書きしない（色や説明を変えていてもそのまま）。名前の大文字小文字は区別しない。
  何度流しても同じ結果になる。作ったラベルと飛ばしたラベルの件数を最後に表示する。
HELP
}

abort() {
  echo "エラー: $1" >&2
  exit 1
}

main() {
  if [[ ${1:-} == '--help' || ${1:-} == '-h' ]]; then
    usage
    exit 0
  fi
  [[ $# -eq 0 ]] || abort "不明な引数: $1（使い方は --help）"

  # 1. 前提チェック
  command -v gh >/dev/null 2>&1 || abort 'gh（GitHub CLI）が見つからない。インストールしてから実行すること。'
  gh auth status >/dev/null 2>&1 || abort 'gh が未認証。`gh auth login` してから実行すること。'
  local repo
  repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner 2>/dev/null)" ||
    abort '対象リポジトリを gh が特定できない。GitHub に紐づく git リポジトリの中で実行すること。'
  echo "対象リポジトリ: $repo"

  # 2. 既存ラベルの名前を1回だけ引く（GitHub のラベル名は大文字小文字を区別しないので小文字にそろえる）
  local existing
  existing="$(gh label list --limit 1000 --json name --jq '.[].name' | tr '[:upper:]' '[:lower:]')" ||
    abort '既存ラベルの一覧を取得できなかった。'

  # 3. 無いものだけ作る
  local entry name color description created=() skipped=()
  for entry in "${LABELS[@]}"; do
    IFS='|' read -r name color description <<<"$entry"
    if grep -Fxq -- "$(tr '[:upper:]' '[:lower:]' <<<"$name")" <<<"$existing"; then
      skipped+=("$name")
      continue
    fi
    gh label create "$name" --color "$color" --description "$description" >/dev/null ||
      abort "ラベル「$name」を作れなかった。ここまでに作った件数: ${#created[@]}"
    created+=("$name")
  done

  # 4. 結果表示
  echo
  echo "作成: ${#created[@]} 件"
  if [[ ${#created[@]} -gt 0 ]]; then
    printf '  %s\n' "${created[@]}"
  fi
  echo "既存のため飛ばした: ${#skipped[@]} 件"
}

main "$@"
