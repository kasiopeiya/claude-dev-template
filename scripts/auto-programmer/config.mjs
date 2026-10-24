// 責務: auto-programmer が外の世界（GitHub・ローカルのファイルシステム）へ繋ぐための設定値を1か所に集める。
//   別のリポジトリ・別のボードで使うときに直すのはこのファイルだけにする（configuration-policy「環境で変わる
//   値はコードに直書きしない」）。例外は branchPrefix（キーのコメントを見る）。ID ではなく人間が読める表記を持たせ、
//   ID は実行時に解決する。

import { homedir } from 'node:os'
import { basename, isAbsolute, resolve } from 'node:path'

const repository = 'kasiopeiya/claude-dev-template'

// AI 専用 clone・実行ログ・clone の番号ロック（locks/）の置き場。人間の作業ツリーと別の場所であれば、どこでもよい。
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

  board: {
    // GitHub Projects（v2）の持ち主と番号。`gh project list --owner <owner>` で調べる
    owner: 'kasiopeiya',
    number: 2,
    // ボード上の表記。`gh project field-list <番号> --owner <owner>` の表示と一字一句合わせる
    statusFieldName: 'Status',
    // 積まれただけで、まだ着手待ちにしていないことを表す選択肢
    todoStatusName: 'Todo',
    readyStatusName: 'Ready',
    inProgressStatusName: 'In progress'
    // レビュー待ちの選択肢は持たない。カードをそこへ動かすのはボードの組み込みワークフローで、このツールは触らない
  },

  // このラベルが付いた Issue だけを対象にする
  targetIssueLabel: 'ai-fixable',

  // トピックブランチ名の前に付ける接頭辞。'st2' なら st2/feat/issue-123、空なら feat/issue-123 になる。
  // ライン（main・main2 など）ごとに CI を分けている利用先で使う。設定したら ci.workflowFile のワークフローの
  // push トリガーにも同じ接頭辞を足す（例 'st2/**'。足さないと CI が走らず PR も作られない）。既存のブランチ名
  // （main2 など）と同じ名前にはできない。キーが無くても空と同じに動く
  branchPrefix: '',

  // claude セッション1回（Skill 1つぶん）を打ち切るまでの時間。無人で固まったまま止まらない事態を防ぐ
  sessionTimeoutMinutes: 60,

  // 着手できる Issue が無かったとき、ボードを見直すまで待つ時間（90秒）。短いほど gh project の呼び出し
  // 頻度が上がり、GitHub API のレートリミットに達しやすくなる
  pollIntervalMinutes: 1.5,

  // 着手できない周（Issue なし・候補を引けず・全件飛ばし）が続いたとき、待ってよい回数の上限。使い切った
  // 次の周も着手できなければ、待たずに止まる（止まるまでおよそ pollIntervalMinutes × この回数）。
  // 放置したまま見直し続けると gh のレートリミットに達するため。
  // このファイルはテンプレート同期の対象外なので、同期した利用先では手で足す。無いと起動時に落ちる
  maxConsecutiveIdleWaits: 10,

  ci: {
    // push で走り、マージ可否を決めるワークフローのファイル名（.github/workflows/ の下）
    workflowFile: 'pipeline.yml',
    // run の状態を見直す間隔
    pollIntervalSeconds: 30,
    // run 1回が終わるまで待つ上限。needs で直列に並ぶジョブの timeout-minutes の合計（最も長い連なり）に、
    // ランナーの起動待ちの分を足す。ワークフローのジョブ構成を変えたら見直す。
    // 対話セッションの hook（.claude/settings.json の PostToolUse）の timeout は、この値に5分足した秒数にしてある。
    // 上げたら、そちらも上げる
    runWaitLimitMinutes: 40,
    // CI が落ちたとき、AI に直させる回数の上限。使い切っても落ちていれば人間へ回す
    maxFixAttempts: 2
  },

  // AI が実装に使う clone の1番。並べて動かすと、2番以降はこの後ろに -<番号> を付ける（index.mjs の acquireWorkspaceDir）。
  // リポジトリ名から導くので、repository を変えれば別の clone になる
  workspaceDir: resolve(autoProgrammerHomeDir, basename(repository)),

  // Issue 1件につき1行を追記する記録。clone の外に置く（clone は毎回デフォルトブランチまで戻されるため）
  runLogPath: resolve(autoProgrammerHomeDir, 'runs.jsonl')
}
