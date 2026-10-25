#!/usr/bin/env bash
# 責務: テンプレートリポジトリ（claude-dev-template）の更新を、このリポジトリへ取り込む。
#   このテンプレートを clone して origin を差し替えたプロジェクトは、テンプレートと git 履歴を
#   共有している。そのため 3-way merge が効き、プロジェクト側の追記を保ったままテンプレート側の
#   変更だけを取り込める（Issue #402）。
#
#   同期用ブランチを切り、--no-commit でマージし、除外パスだけ元に戻して停止する。
#   commit と本線へのマージは人間が行う。
#
#   TEMPLATE_URL・EXCLUDE_PATHS・EXCLUDE_EXCEPTIONS は、/setup と scripts/ci/check-markdown-links.mjs が
#   文字列として読む。readonly・シングルクォートの書式を変えず、配列の中に ' や ) を含むコメントを置かない。
#   is_excluded の判定を変えたら、check-markdown-links.mjs の isExcludedFromSync も同じに直す。
#
# 実行方法・除外対象・衝突したときの対処は `./scripts/sync-template.sh --help` を見ること
# （説明の正は下の usage()。ここに二重に書かない）。

set -euo pipefail

readonly TEMPLATE_URL='https://github.com/kasiopeiya/claude-dev-template.git'
readonly TEMPLATE_BRANCH='main'

# 除外パス。末尾が / のものはディレクトリ配下すべて、それ以外は完全一致で判定する。
readonly EXCLUDE_PATHS=(
  'README.md'
  '.gitignore'
  'docs/requirements.md'
  'docs/design/'
  'docs/design-hub.md'
  'docs/adr/'
  'docs/project-context/'
  '.github/'
  'scripts/auto-programmer/config.mjs'
)

# 除外の例外。EXCLUDE_PATHS に当たっても、ここに挙げたパスは同期する。
readonly EXCLUDE_EXCEPTIONS=(
  '.github/workflows/doc-consistency-weekly.yml'
  '.github/workflows/code-policy-weekly.yml'
  '.github/workflows/close-human-review-issue.yml'
  'docs/adr/adr-template.md'
)

usage() {
  cat <<'HELP'
使い方:
  ./scripts/sync-template.sh          テンプレートの更新を同期ブランチに取り込む（commit はしない）
  ./scripts/sync-template.sh --help   この使い方を表示する

前提:
  git リポジトリの中で、未コミットの変更が無い状態で実行すること。
  どちらか欠けていれば、何も変更せずエラー終了する。

除外するパス（プロジェクト固有の内容に育つため、テンプレート側の変更を取り込まない）:
HELP
  printf '  %s\n' "${EXCLUDE_PATHS[@]}"
  cat <<'HELP'

  docs/adr/ を除外するのは、利用先ではハーネスが補助でありテンプレートの ADR を
  利用先の ADR 一覧に混ぜないため。同期されるファイルからは ADR を参照しない
  （利用先ではテンプレートの ADR を消すので、参照が切れる）。

除外の例外（除外パスに当たっても同期する。.github/ は丸ごと除外のため、テンプレート側の
ワークフローを利用先へ届けるにはここへ足す必要がある）:
HELP
  printf '  %s\n' ${EXCLUDE_EXCEPTIONS[@]+"${EXCLUDE_EXCEPTIONS[@]}"}
  cat <<'HELP'

衝突したときの対処:
  衝突が出ても中断せず、除外処理まで進めて衝突ファイル一覧を表示して停止する。
  表示されたファイルを開いて衝突マーカーを解消し、git add してから commit する。
  同期をやめるときは git merge --abort のうえ、作られた同期ブランチを削除する。
HELP
}

abort() {
  echo "エラー: $1" >&2
  exit 1
}

# 引数 path が除外対象なら 0 を返す。
is_excluded() {
  local path="$1" exception pattern
  for exception in ${EXCLUDE_EXCEPTIONS[@]+"${EXCLUDE_EXCEPTIONS[@]}"}; do
    [[ "$path" == "$exception" ]] && return 1
  done
  for pattern in "${EXCLUDE_PATHS[@]}"; do
    if [[ "$pattern" == */ ]]; then
      [[ "$path" == "$pattern"* ]] && return 0
    else
      [[ "$path" == "$pattern" ]] && return 0
    fi
  done
  return 1
}

# 同期ブランチ名を決める。同名があれば連番を付ける。
resolve_branch_name() {
  local base
  base="sync/template-$(date +%Y%m%d)"
  local candidate="$base"
  local suffix=2
  while git show-ref --verify --quiet "refs/heads/$candidate"; do
    candidate="$base-$suffix"
    suffix=$((suffix + 1))
  done
  echo "$candidate"
}

print_list() {
  local title="$1"
  shift
  echo
  echo "$title"
  if [[ $# -eq 0 ]]; then
    echo "  （なし）"
  else
    printf '  %s\n' "$@"
  fi
}

# 衝突しても中断せず、除外処理まで進める。merge が始まらなかった失敗（MERGE_HEAD が無い）だけは止める。
merge_template_without_commit() {
  local branch=$1
  if ! git merge --no-commit --no-ff --allow-unrelated-histories FETCH_HEAD; then
    git rev-parse -q --verify MERGE_HEAD >/dev/null ||
      abort "マージを始められなかった（上の git のエラーを参照）。同期ブランチ $branch を消してやり直すこと。"
  fi
}

remaining_conflicts=()
imported_paths=()
restored_paths=()

# 衝突したパスのうち、除外して戻すもの以外を remaining_conflicts に積む。
# 除外処理より前に呼ぶ（戻すと衝突の記録が消える）。is_excluded で文字列として比べるので quotePath を切る。
collect_remaining_conflicts() {
  local path
  while IFS= read -r path; do
    if [[ -n $path ]] && ! is_excluded "$path"; then
      remaining_conflicts+=("$path")
    fi
  done < <(git -c core.quotePath=false ls-files -u | cut -f2 | sort -u)
}

# マージで変わったパスのうち、除外パスを HEAD の内容に戻して restored_paths に積む。
# --no-renames：リネームを1件にまとめると移動元が出ず、除外パスからの移動元を戻せないため。
restore_excluded_paths() {
  local changed=() path
  while IFS= read -r path; do
    if [[ -n $path ]]; then
      changed+=("$path")
    fi
  done < <(git -c core.quotePath=false diff --name-only --no-renames HEAD)

  for path in ${changed[@]+"${changed[@]}"}; do
    is_excluded "$path" || continue
    if git cat-file -e "HEAD:$path" 2>/dev/null; then
      git checkout HEAD -- "$path"
    else
      # テンプレート側の新規追加分。プロジェクトには不要なので削除する。
      git rm -f --quiet -- "$path"
    fi
    restored_paths+=("$path")
  done
}

# 除外パスを戻した後も HEAD と差があるパス（テンプレートから取り込んだもの）を imported_paths に積む。
collect_imported_paths() {
  local path
  while IFS= read -r path; do
    if [[ -n $path ]]; then
      imported_paths+=("$path")
    fi
  done < <(git -c core.quotePath=false diff --name-only --no-renames HEAD)
}

print_sync_result() {
  local branch=$1
  echo
  echo "=== テンプレート同期の結果 ==="
  echo "同期ブランチ: $branch"
  print_list '取り込んだファイル:' ${imported_paths[@]+"${imported_paths[@]}"}
  print_list '除外して元に戻したファイル:' ${restored_paths[@]+"${restored_paths[@]}"}
  print_list '衝突したファイル:' ${remaining_conflicts[@]+"${remaining_conflicts[@]}"}
  echo
  echo 'commit はしていない。内容を確認し、衝突があれば解消してから commit すること。'
  echo '同期をやめるときは git merge --abort のうえ、このブランチを削除する。'
}

# 前提を確かめ、リポジトリ直下へ移る。cd を呼び出し元に効かせるため、サブシェルで呼ばない。
# git diff はリポジトリ直下からのパスを返し、checkout・rm は実行場所からのパスとして読むので、直下にそろえる。
move_to_clean_repo_root() {
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || abort 'git リポジトリの中で実行すること。'
  cd "$(git rev-parse --show-toplevel)"
  [[ -z "$(git status --porcelain)" ]] || abort '未コミットの変更がある。commit または stash してから実行すること。'
}

# テンプレートを FETCH_HEAD に取る。リモートとしては登録せず、origin にも触れない。
fetch_template() {
  echo "テンプレートを取得する: $TEMPLATE_URL ($TEMPLATE_BRANCH)"
  git fetch "$TEMPLATE_URL" "$TEMPLATE_BRANCH"
}

switch_to_sync_branch() {
  local branch=$1
  git switch -c "$branch"
  echo "同期ブランチを作成した: $branch"
}

main() {
  if [[ ${1:-} == '--help' || ${1:-} == '-h' ]]; then
    usage
    exit 0
  fi
  [[ $# -eq 0 ]] || abort "不明な引数: $1（使い方は --help）"

  move_to_clean_repo_root
  fetch_template
  local branch
  branch="$(resolve_branch_name)"
  switch_to_sync_branch "$branch"
  merge_template_without_commit "$branch"
  collect_remaining_conflicts
  restore_excluded_paths
  collect_imported_paths
  print_sync_result "$branch"
}

main "$@"
