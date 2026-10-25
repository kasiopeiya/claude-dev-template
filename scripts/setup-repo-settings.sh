#!/usr/bin/env bash
# 責務: CI（.github/workflows/）が前提とする GitHub のリポジトリ設定を、対象リポジトリへ入れる。
#   設定は clone しても付いてこず、既定値のままだと最初の push で `pipeline.yml` の
#   `create-pull-request` が「Actions は PR を作れない」で落ちる。人間が Settings 画面で
#   手作業すると漏れるため、使い始めに1回流して入れる（Issue #1165）。
#
#   入れる値はテンプレート本体の実設定に合わせる。各設定がどのワークフローのためにあるかは usage() に、
#   壊すとどうなるかは samples/docs/design/cicd-design.md の「GitHubリポジトリ設定」に書く。
#   シークレット（CLAUDE_CODE_OAUTH_TOKEN）は値を人間しか持たないので扱わない。
#
# 実行方法・前提は `./scripts/setup-repo-settings.sh --help` を見ること
# （説明の正は下の usage()。ここに二重に書かない）。

set -euo pipefail

# shellcheck source=lib/resolve-origin-repo.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/resolve-origin-repo.sh"

# マージ可否を決める唯一の required check（pipeline.yml の cicd-gate ジョブ）。
readonly REQUIRED_CHECK='cicd-gate'

# デフォルトブランチに作るルールセット。actor_id 5 は Repository admin ロールで、管理者だけが迂回できる。
# strict=false（最新の main の取り込みを必須にしない）の理由は cicd-design.md の「ブランチの最新取り込み」行。
print_ruleset_json() {
  cat <<JSON
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "do_not_enforce_on_create": false,
        "required_status_checks": [{ "context": "$REQUIRED_CHECK" }]
      }
    }
  ],
  "bypass_actors": [{ "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" }]
}
JSON
}

usage() {
  cat <<'HELP'
使い方:
  ./scripts/setup-repo-settings.sh          CI が前提とするリポジトリ設定を入れる
  ./scripts/setup-repo-settings.sh --help   この使い方を表示する

前提:
  gh（GitHub CLI）が入っていて、`gh auth login` 済みであること。
  対象リポジトリの管理者（admin）権限を持つアカウントで実行すること。
  対象は、カレントの git リポジトリの origin が指すリポジトリ（実行時に表示する）。
  upstream など別の remote があっても、そちらには書き込まない。

入れる設定:
  1. マージ設定: auto-merge を許す・merge commit を許す・マージ済みブランチを自動で消す
     （pr-ai-triage.yml が `gh pr merge --auto --merge` で予約する）
  2. Actions 設定: Actions に PR の作成・承認を許す
     （pipeline.yml の create-pull-request が PR を作る）。既定のトークン権限は今の値のまま変えない
  3. デフォルトブランチのルールセット: cicd-gate の成功を必須にし、削除と force push を禁じる。
     管理者だけが迂回できる

動作:
  1・2 は値を上書きする。CI が動く前提の値なので、変えていても戻す。
  3 は、デフォルトブランチに cicd-gate を必須にするルールが既にあれば作らない（利用先の変更を残す）。
  何度流しても同じ結果になる。1つの段が失敗しても残りの段は続け、最後に失敗した段を表示して
  終了コード 1 で終わる。組織所有のリポジトリでは組織の設定が優先され、2 が失敗することがある。
  private リポジトリは GitHub Free プランだと 3 が失敗する。
HELP
}

abort() {
  echo "エラー: $1" >&2
  exit 1
}

applied_stages=()
skipped_stages=()
failed_stages=()

apply_merge_settings() {
  local repo=$1 err
  if err="$(gh api -X PATCH "repos/$repo" \
    -F allow_auto_merge=true \
    -F allow_merge_commit=true \
    -F delete_branch_on_merge=true 2>&1 >/dev/null)"; then
    applied_stages+=('マージ設定（auto-merge・merge commit・マージ済みブランチの自動削除）')
  else
    failed_stages+=("マージ設定: $err")
  fi
}

apply_actions_settings() {
  local repo=$1 current_workflow_permissions err
  # PUT は既定のトークン権限も受け取るので、今の値を引いてそのまま渡す（変えないため）
  if ! current_workflow_permissions="$(gh api "repos/$repo/actions/permissions/workflow" --jq .default_workflow_permissions 2>&1)"; then
    failed_stages+=("Actions 設定: 今の設定を取得できなかった: $current_workflow_permissions")
    return
  fi
  if err="$(gh api -X PUT "repos/$repo/actions/permissions/workflow" \
    -f default_workflow_permissions="$current_workflow_permissions" \
    -F can_approve_pull_request_reviews=true 2>&1 >/dev/null)"; then
    applied_stages+=('Actions 設定（Actions に PR の作成・承認を許す）')
  else
    failed_stages+=("Actions 設定: $err（組織所有なら、組織の Settings → Actions で許可されているかを確かめる）")
  fi
}

apply_ruleset() {
  local repo=$1 default_branch matching_rule_output err
  if ! default_branch="$(gh repo view "$repo" --json defaultBranchRef --jq .defaultBranchRef.name 2>&1)"; then
    failed_stages+=("ルールセット: デフォルトブランチを取得できなかった: $default_branch")
    return
  fi
  # コミットの無い空のリポジトリでは defaultBranchRef が null になり、gh は空文字を返す
  if [[ -z $default_branch ]]; then
    failed_stages+=('ルールセット: デフォルトブランチが無い（コミットの無い空のリポジトリ）。最初のコミットを push してから流し直すこと')
    return
  fi
  # ルールセット名ではなく、ブランチに実際に効いているルールで判定する（名前を変えていても重ねて作らない）。
  # --paginate では jq がページごとに評価されるので、一致したルールだけを出し、出力が空かで判定する
  if ! matching_rule_output="$(gh api --paginate "repos/$repo/rules/branches/$default_branch" --jq \
    ".[] | select(.type == \"required_status_checks\" and any(.parameters.required_status_checks[]; .context == \"$REQUIRED_CHECK\")) | .type" 2>&1)"; then
    failed_stages+=("ルールセット: $default_branch に効いているルールを取得できなかった: $matching_rule_output")
    return
  fi
  if [[ -n $matching_rule_output ]]; then
    skipped_stages+=("ルールセット（$default_branch に $REQUIRED_CHECK の必須チェックが既にある）")
    return
  fi
  if err="$(gh api -X POST "repos/$repo/rulesets" --input - < <(print_ruleset_json) 2>&1 >/dev/null)"; then
    applied_stages+=("ルールセット（$default_branch で $REQUIRED_CHECK を必須・削除と force push を禁止）")
  else
    failed_stages+=("ルールセット: $err（private リポジトリは GitHub Free プランでは作れない）")
  fi
}

print_summary() {
  echo
  echo "設定した: ${#applied_stages[@]} 件"
  if [[ ${#applied_stages[@]} -gt 0 ]]; then
    printf '  %s\n' "${applied_stages[@]}"
  fi
  echo "既にあるため飛ばした: ${#skipped_stages[@]} 件"
  if [[ ${#skipped_stages[@]} -gt 0 ]]; then
    printf '  %s\n' "${skipped_stages[@]}"
  fi
  if [[ ${#failed_stages[@]} -gt 0 ]]; then
    echo "失敗した: ${#failed_stages[@]} 件" >&2
    printf '  %s\n' "${failed_stages[@]}" >&2
  fi
}

main() {
  if [[ ${1:-} == '--help' || ${1:-} == '-h' ]]; then
    usage
    exit 0
  fi
  [[ $# -eq 0 ]] || abort "不明な引数: $1（使い方は --help）"

  local repo
  repo="$(resolve_origin_repo)" || exit 1
  echo "対象リポジトリ: $repo"

  # 1つの段が失敗しても次の段へ進む（失敗は最後にまとめて表示する）
  apply_merge_settings "$repo"
  apply_actions_settings "$repo"
  apply_ruleset "$repo"

  print_summary
  [[ ${#failed_stages[@]} -eq 0 ]] || exit 1
}

main "$@"
