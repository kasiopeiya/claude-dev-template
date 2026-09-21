// 責務: auto-programmer が外の世界（GitHub・ローカルのファイルシステム）へ繋ぐための設定値を1か所に集める。
//   別のリポジトリ・別のボードで使うときに直すのはこのファイルだけにする（configuration-policy「環境で変わる
//   値はコードに直書きしない」）。ID ではなく人間が読める表記を持たせ、ID は実行時に解決する。

import { homedir } from 'node:os'
import { basename, resolve } from 'node:path'

const repository = 'kasiopeiya/claude-dev-template'

// AI 専用 clone と実行ログの置き場。人間の作業ツリーと別の場所であれば、どこでもよい。
// 置き場だけを変えたい人が追跡対象のこのファイルを編集せずに済むよう、環境変数で上書きできる
const autoProgrammerHomeDir =
  process.env.AUTO_PROGRAMMER_HOME ?? resolve(homedir(), 'dev/auto-programmer')

export const config = {
  // Issue と PR の相手（owner/repo）。`gh repo clone` の引数にもなる
  repository,

  // PR のマージ先。トピックブランチもここから切る
  baseBranch: 'main',

  board: {
    // GitHub Projects（v2）の持ち主と番号。`gh project list --owner <owner>` で調べる
    owner: 'kasiopeiya',
    number: 2,
    // ボード上の表記。`gh project field-list <番号> --owner <owner>` の表示と一字一句合わせる
    statusFieldName: 'Status',
    readyStatusName: 'Ready',
    inProgressStatusName: 'In progress'
  },

  // このラベルが付いた Issue だけを対象にする
  targetIssueLabel: 'ai-fixable',

  // 1件ぶんの claude セッションを打ち切るまでの時間。無人で固まったまま止まらない事態を防ぐ
  sessionTimeoutMinutes: 120,

  // AI が実装に使う clone。リポジトリ名から導くので、repository を変えれば別の clone になる
  workspaceDir: resolve(autoProgrammerHomeDir, basename(repository)),

  // 1回の実行につき1行を追記する記録。clone の外に置く（clone は毎回 origin/main まで戻されるため）
  runLogPath: resolve(autoProgrammerHomeDir, 'runs.jsonl')
}
