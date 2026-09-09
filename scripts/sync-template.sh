#!/usr/bin/env bash
# 責務: テンプレートリポジトリ（claude-dev-template）の更新を、このリポジトリへ取り込む。
#   このテンプレートを clone して origin を差し替えたプロジェクトは、テンプレートと git 履歴を
#   共有している。そのため 3-way merge が効き、プロジェクト側の追記を保ったままテンプレート側の
#   変更だけを取り込める（Issue #402）。
#
#   同期用ブランチを切り、--no-commit でマージし、除外パスだけ元に戻して停止する。
#   commit と本線へのマージは人間が行う。
#
# 実行方法・除外対象・衝突したときの対処は `./scripts/sync-template.sh --help` を見ること
# （説明の正は下の usage()。ここに二重に書かない）。

set -euo pipefail

readonly TEMPLATE_URL='https://github.com/kasiopeiya/claude-dev-template.git'
readonly TEMPLATE_BRANCH='main'

# 除外パス。末尾が / のものはディレクトリ配下すべて、それ以外は完全一致で判定する。
readonly EXCLUDE_PATHS=(
  'README.md'
  'docs/requirements.md'
  'docs/design/'
  'docs/design-hub.md'
  'docs/adr/adr-index.md'
  'docs/reference/glossary.md'
  '.github/'
)

# 除外の例外。EXCLUDE_PATHS に当たっても、ここに挙げたパスは同期する。
readonly EXCLUDE_EXCEPTIONS=(
  '.github/workflows/pipeline.yml'
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
  README.md / docs/requirements.md / docs/design/ / docs/design-hub.md /
  docs/adr/adr-index.md / docs/reference/glossary.md / .github/
  ただし .github/workflows/pipeline.yml だけは例外として同期する（CI ガードレールの改善を届けるため）。

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
  for exception in "${EXCLUDE_EXCEPTIONS[@]}"; do
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
  local base="sync/template-$(date +%Y%m%d)"
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

main() {
  if [[ ${1:-} == '--help' || ${1:-} == '-h' ]]; then
    usage
    exit 0
  fi
  [[ $# -eq 0 ]] || abort "不明な引数: $1（使い方は --help）"

  # 1. 前提チェック
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || abort 'git リポジトリの中で実行すること。'
  [[ -z "$(git status --porcelain)" ]] || abort '未コミットの変更がある。commit または stash してから実行すること。'

  # 2. fetch（リモートとしては登録せず、origin にも触れない）
  echo "テンプレートを取得する: $TEMPLATE_URL ($TEMPLATE_BRANCH)"
  git fetch "$TEMPLATE_URL" "$TEMPLATE_BRANCH"

  # 3. 同期ブランチ作成
  local branch
  branch="$(resolve_branch_name)"
  git switch -c "$branch"
  echo "同期ブランチを作成した: $branch"

  # 4. マージ（マージコミットは作らない。衝突しても中断しない）
  git merge --no-commit --no-ff FETCH_HEAD || true

  # 5. 除外処理
  local conflicted=() imported=() restored=() changed=() path
  while IFS= read -r path; do
    [[ -n "$path" ]] && conflicted+=("$path")
  done < <(git ls-files -u | cut -f2 | sort -u)

  while IFS= read -r path; do
    [[ -n "$path" ]] && changed+=("$path")
  done < <(git diff --name-only HEAD)

  for path in ${changed[@]+"${changed[@]}"}; do
    if is_excluded "$path"; then
      if git cat-file -e "HEAD:$path" 2>/dev/null; then
        git checkout HEAD -- "$path"
      else
        # テンプレート側の新規追加分。プロジェクトには不要なので削除する。
        git rm -f --quiet -- "$path"
      fi
      restored+=("$path")
    else
      imported+=("$path")
    fi
  done

  # 除外して戻したものは衝突一覧からも消す（人間が対処すべき衝突ではなくなったため）。
  local remaining_conflicts=()
  for path in ${conflicted[@]+"${conflicted[@]}"}; do
    is_excluded "$path" || remaining_conflicts+=("$path")
  done

  # 6. 結果表示して停止
  echo
  echo "=== テンプレート同期の結果 ==="
  echo "同期ブランチ: $branch"
  print_list '取り込んだファイル:' ${imported[@]+"${imported[@]}"}
  print_list '除外して元に戻したファイル:' ${restored[@]+"${restored[@]}"}
  print_list '衝突したファイル:' ${remaining_conflicts[@]+"${remaining_conflicts[@]}"}
  echo
  echo 'commit はしていない。内容を確認し、衝突があれば解消してから commit すること。'
  echo '同期をやめるときは git merge --abort のうえ、このブランチを削除する。'
}

main "$@"
