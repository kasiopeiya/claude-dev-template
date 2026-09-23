// 責務: auto-programmer が外の世界（GitHub・ローカルのファイルシステム）へ繋ぐための設定値を1か所に集める。
//   別のリポジトリ・別のボードで使うときに直すのはこのファイルだけにする（configuration-policy「環境で変わる
//   値はコードに直書きしない」）。ID ではなく人間が読める表記を持たせ、ID は実行時に解決する。

import { homedir } from 'node:os'
import { basename, isAbsolute, resolve } from 'node:path'

const repository = 'kasiopeiya/claude-dev-template'

// AI 専用 clone と実行ログの置き場。人間の作業ツリーと別の場所であれば、どこでもよい。
// 置き場だけを変えたい人が追跡対象のこのファイルを編集せずに済むよう、環境変数で上書きできる
// 空文字・相対パスは作業ディレクトリ基準で解決され、clone が人間の作業ツリーの中にできるので受け付けない
const autoProgrammerHomeDir =
  process.env.AUTO_PROGRAMMER_HOME || resolve(homedir(), 'dev/auto-programmer')
if (!isAbsolute(autoProgrammerHomeDir)) {
  throw new Error(`AUTO_PROGRAMMER_HOME は絶対パスで指定してください: ${autoProgrammerHomeDir}`)
}

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

  // claude セッション1回（Skill 1つぶん）を打ち切るまでの時間。無人で固まったまま止まらない事態を防ぐ
  sessionTimeoutMinutes: 120,

  // 着手できる Issue が無かったとき、ボードを見直すまで待つ時間（90秒）。短いほど gh project の呼び出し
  // 頻度が上がり、GitHub API のレートリミットに達しやすくなる
  pollIntervalMinutes: 1.5,

  ci: {
    // push で走り、マージ可否を決めるワークフローのファイル名（.github/workflows/ の下）
    workflowFile: 'pipeline.yml',
    // run の状態を見直す間隔
    pollIntervalSeconds: 30,
    // run 1回が終わるまで待つ上限。needs で直列に並ぶジョブの timeout-minutes の合計（最も長い連なり）に、
    // ランナーの起動待ちの分を足す。ワークフローのジョブ構成を変えたら見直す
    runWaitLimitMinutes: 40,
    // CI が落ちたとき、AI に直させる回数の上限。使い切っても落ちていれば人間へ回す
    maxFixAttempts: 2
  },

  // AI が実装に使う clone。リポジトリ名から導くので、repository を変えれば別の clone になる
  workspaceDir: resolve(autoProgrammerHomeDir, basename(repository)),

  // Issue 1件につき1行を追記する記録。clone の外に置く（clone は毎回 origin/main まで戻されるため）
  runLogPath: resolve(autoProgrammerHomeDir, 'runs.jsonl')
}
