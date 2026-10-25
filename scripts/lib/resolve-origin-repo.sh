# 責務: gh で GitHub に書き込むスクリプトの書き込み先を、カレントの
#   git リポジトリの origin が指す GitHub リポジトリに決める。source して使う。
#
#   gh の既定の解決は upstream の remote を優先しうるので、origin を名指しして書き込み先を取り違えない。
#   認証は `gh auth status` で確かめない。どれか1つのホストのトークンが切れているだけで失敗するため、
#   対象リポジトリを引く呼び出しの失敗で止め、gh のエラーをそのまま見せる。

# origin の URL を、gh が解決できる「ホスト/owner/name」の形に直して出力する。
# gh は引数で受けた SSH の URL のホストを ~/.ssh/config で引き直さないので、ホスト別名（Host github-work など）を
# `ssh -G` で実ホスト名に直す。SSH 以外の URL はそのまま出力する。
normalize_remote_url_for_gh() {
  local url=$1 url_host repository_path resolved_hostname
  if [[ $url =~ ^ssh://([^@/]+@)?([^:/]+)(:[0-9]+)?/(.+)$ ]]; then
    url_host=${BASH_REMATCH[2]}
    repository_path=${BASH_REMATCH[4]}
  elif [[ $url != *://* && $url =~ ^([^@/:]+@)?([^:/]+):(.+)$ ]]; then
    url_host=${BASH_REMATCH[2]}
    repository_path=${BASH_REMATCH[3]}
  else
    echo "$url"
    return
  fi
  # ssh が無い・設定を読めないときは、別名ではないとみなしてホスト名をそのまま使う
  resolved_hostname="$(ssh -G "$url_host" 2>/dev/null | awk '/^hostname /{print $2; exit}')" || true
  # git は host:/owner/repo や末尾の / も受け付けるが、gh は HOST/OWNER/REPO の形しか受け付けない
  repository_path=${repository_path#/}
  repository_path=${repository_path%/}
  echo "${resolved_hostname:-$url_host}/${repository_path%.git}"
}

# origin のリポジトリを owner/name で出力する。引けなければ理由を stderr に出して 1 を返す。
resolve_origin_repo() {
  local origin_url repo
  if ! command -v gh >/dev/null 2>&1; then
    echo 'エラー: gh（GitHub CLI）が見つからない。インストールしてから実行すること。' >&2
    return 1
  fi
  # 空の引数を渡すと gh は既定の解決に戻るので、origin が無ければここで止める
  if ! origin_url="$(git remote get-url origin 2>/dev/null)"; then
    echo 'エラー: origin の remote が無い。origin が GitHub を指す git リポジトリの中で実行すること。' >&2
    return 1
  fi
  if ! repo="$(gh repo view "$(normalize_remote_url_for_gh "$origin_url")" --json nameWithOwner --jq .nameWithOwner 2>&1)"; then
    # origin の URL は出さない（https://user:token@... のように認証情報を含みうるため）
    echo "エラー: origin のリポジトリを引けなかった（未認証なら \`gh auth login\` する）: $repo" >&2
    return 1
  fi
  echo "$repo"
}
