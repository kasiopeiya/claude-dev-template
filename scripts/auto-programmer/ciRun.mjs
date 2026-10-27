// 責務: push 後の CI の run の状態を読み、次に何をするかと、直させずに終えた run を記録に残す文言と、人間へ回す Issue に書く文面とを決める純粋関数だけを担う。これまでに直させた回数を、ブランチの run から数えることも含む。
//
// 設計意図（WHY）:
// - run は head SHA で特定する。CI のワークフローは同じブランチの古い run をキャンセルするので、ブランチ名だけで
//   引くと、キャンセルされた古い run を「落ちた」と取り違える。
// - 直させるのは conclusion が failure・timed_out のときだけにする。キャンセル・承認待ちなどは差分の中身で
//   直せる失敗ではなく、AI に直させても空振りする。
// - I/O を持たない層をここに切り出すことで、GitHub に触れずに確かめられる。

import { TechnicalError } from '../lib/errors.mjs'

const FIXABLE_CONCLUSIONS = new Set(['failure', 'timed_out'])

// readCiRunState が読む項目。`gh run list --json` に渡す側と読む側で食い違うと、run を常に「まだ無い」と読んでしまう
export const CI_RUN_STATE_FIELDS = 'databaseId,status,conclusion,headSha,url'

// countPastFixAttempts と selectRunsCreatedSince が読む項目。食い違って status が来ないと、直させた回数を常に0と数え、
// 上限が効かなくなる。createdAt が来ないと、絞り込みがすべての run を除き、同じく上限が効かなくなる
export const PAST_FIX_ATTEMPT_FIELDS = 'databaseId,status,conclusion,createdAt'

/**
 * `gh run list` の結果から、指定した commit の run の状態を読む。
 *
 * 同じ commit に run が複数あるとき（再実行など）は、databaseId の最も大きいもの（最後に作られたもの）を見る。
 *
 * @param {{ databaseId: number, status: string, conclusion: string, headSha: string, url: string }[]} runs `gh run list --json databaseId,status,conclusion,headSha,url` の出力
 * @param {string} headSha 待っている commit の SHA
 * @returns {{ state: 'pending' | 'success' | 'fixable-failure' | 'unfixable', runId: number | null, conclusion: string | null, url: string | null }} run の状態（run がまだ無い・終わっていないときは pending）
 */
export function readCiRunState(runs, headSha) {
  const latestRun = runs
    .filter((run) => run.headSha === headSha)
    .reduce((latest, run) => (latest && latest.databaseId > run.databaseId ? latest : run), null)
  if (!latestRun) return { state: 'pending', runId: null, conclusion: null, url: null }

  const { databaseId: runId, status, conclusion, url } = latestRun
  if (status !== 'completed') return { state: 'pending', runId, conclusion: null, url }
  if (conclusion === 'success') return { state: 'success', runId, conclusion, url }
  if (FIXABLE_CONCLUSIONS.has(conclusion))
    return { state: 'fixable-failure', runId, conclusion, url }
  return { state: 'unfixable', runId, conclusion, url }
}

/**
 * run の一覧から、指定した時刻以降に作られた run だけを残す。同じ名前のブランチを作り直した前の回の run を除くために使う。
 *
 * @template {{ createdAt: string }} Run
 * @param {{ runs: Run[], sinceMs: number }} params `gh run list --json <PAST_FIX_ATTEMPT_FIELDS>` の出力と、残す下限の時刻（epoch ミリ秒。この時刻ちょうどの run は残す）
 * @returns {Run[]} 下限以降に作られた run
 */
export function selectRunsCreatedSince({ runs, sinceMs }) {
  return runs.filter((run) => Date.parse(run.createdAt) >= sinceMs)
}

/**
 * ブランチの run の一覧から、これまでに直させた回数を数える。
 *
 * 直させる対象の終わり方（failure・timed_out）をした run のうち、いま見ている落ちた run を除いた数を返す。
 * 同じ名前のブランチを作り直した前の回の run は、呼び出し側が selectRunsCreatedSince で除いてから渡す。
 *
 * @param {{ branchRuns: { databaseId: number, status: string, conclusion: string }[], currentRunId: number }} params `gh run list --branch <ブランチ> --json <PAST_FIX_ATTEMPT_FIELDS>` の出力と、いま見ている落ちた run の ID（数えない）
 * @returns {number} これまでに直させた回数
 */
export function countPastFixAttempts({ branchRuns, currentRunId }) {
  return branchRuns.filter(
    (run) =>
      run.databaseId !== currentRunId &&
      run.status === 'completed' &&
      FIXABLE_CONCLUSIONS.has(run.conclusion)
  ).length
}

/**
 * 待ち終えた run の状態から、次にすることを決める。
 *
 * @param {{ state: 'pending' | 'success' | 'fixable-failure' | 'unfixable', fixAttemptCount: number, maxFixAttempts: number }} params run の状態（待ち時間を使い切ってもまだ終わっていなければ pending）と、これまでに直させた回数・直させてよい上限
 * @returns {'finish-passed' | 'fix' | 'hand-over' | 'stop-timed-out' | 'stop-unfixable'} 通ったので終える／直させる／上限まで直させても落ちたので人間へ回す／待ち時間内に終わらなかったのでやめる／直せない終わり方をしたのでやめる
 */
export function decideAfterCiRun({ state, fixAttemptCount, maxFixAttempts }) {
  if (state === 'success') return 'finish-passed'
  if (state === 'pending') return 'stop-timed-out'
  if (state === 'unfixable') return 'stop-unfixable'
  return fixAttemptCount < maxFixAttempts ? 'fix' : 'hand-over'
}

/**
 * 直させずに終える run について、記録に残す CI の結果の文言を決める。
 *
 * @param {{ nextStep: 'finish-passed' | 'hand-over' | 'stop-timed-out' | 'stop-unfixable', conclusion: string | null, runWaitLimitMinutes: number, maxFixAttempts: number }} params decideAfterCiRun の結果（直させる 'fix' は渡さない）・待ち終えた run の conclusion・run を待つ上限の分数・直させてよい上限の回数
 * @returns {string} 記録に残す CI の結果
 * @throws {TechnicalError} nextStep が直させずに終える値でないとき（'fix' を渡したとき）
 */
export function describeCiOutcome({ nextStep, conclusion, runWaitLimitMinutes, maxFixAttempts }) {
  switch (nextStep) {
    case 'finish-passed':
      return 'CI が通りました'
    case 'stop-timed-out':
      return `CI の run が ${runWaitLimitMinutes} 分以内に終わりませんでした（run が見つからない場合を含む）`
    case 'stop-unfixable':
      return `CI の run が ${conclusion} で終わったので直させません`
    case 'hand-over':
      return `${maxFixAttempts} 回直させても CI が通らないので人間へ回しました`
    default:
      // 黙って undefined を返すと、記録の CI の結果が抜けたまま誰にも気づかれない
      throw new TechnicalError(`直させずに終える nextStep ではありません: ${nextStep}`)
  }
}

/**
 * 上限まで直させても CI が落ちている Issue に、`/auto-dev` の離脱と同じく、人間へ回す理由として書くコメントの本文を決める。
 *
 * @param {{ workflowFile: string, maxFixAttempts: number, lastRunUrl: string | null }} params CI のワークフローのファイル名・直させてよい上限の回数・最後に落ちた run の URL
 * @returns {string} Issue に書くコメントの本文
 */
export function buildHandOverComment({ workflowFile, maxFixAttempts, lastRunUrl }) {
  return `CI（${workflowFile}）が、/auto-fix-ci で ${maxFixAttempts} 回直させても通りませんでした。最後に落ちた run: ${lastRunUrl}\n\n専用のセッションでこの Issue に着手してください。`
}
