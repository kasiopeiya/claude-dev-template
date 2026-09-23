// 責務: push 後の CI の run の状態を読み、次に何をするか（通った・直させる・諦める・直させずにやめる）を
//   決める純粋関数だけを担う。
//
// 設計意図（WHY）:
// - run は head SHA で特定する。CI のワークフローは同じブランチの古い run をキャンセルするので、ブランチ名だけで
//   引くと、キャンセルされた古い run を「落ちた」と取り違える。
// - 直させるのは conclusion が failure・timed_out のときだけにする。キャンセル・承認待ちなどは差分の中身で
//   直せる失敗ではなく、AI に直させても空振りする。
// - I/O を持たない層をここに切り出すことで、GitHub に触れずに単体テストできる。

const FIXABLE_CONCLUSIONS = new Set(['failure', 'timed_out'])

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
