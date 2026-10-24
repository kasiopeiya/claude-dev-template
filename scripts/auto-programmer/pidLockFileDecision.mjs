// 責務: PID 入りのロックファイルについて、中身の組み立て・持ち主の読み出しと、ロックが死んでいるか・一番小さい空き番号はどれかの判断を担う純粋関数だけを置く。
//   ファイルの読み書きとプロセスの確認は pidLockFile.mjs が持つ。
//
// 設計意図（WHY）:
// - import を1つも持たない形に保ち、ファイルもプロセスも要らずに確かめられるようにする（unit-test-policy）。
//   判断を誤ると、2つのプロセスが同じ clone で reset --hard し合う・同じ Issue を実装し合うか、
//   空いている番号を使えずに clone が増え続ける・Issue を拾えなくなる。
// - 死んだとみなすのは、PID のプロセスが動いていないときと、マシンの起動時刻より前に作られたときである。node が落ちても
//   ロックが残り続けないようにする。再起動すると PID が再利用されるので、PID の確認だけでは前回の起動のロックを見分けられない。
// - 起動時刻より前かは、起動ごとに変わる ID（Linux の boot_id）を引ける OS ではそれで見分ける。引けない OS では、時刻と
//   起動時刻を比べる。起動時刻は「いまの時刻 − 起動してからの秒数」で引くので、起動からの秒数が一時停止の間を数えない
//   VM（WSL2 など）では、再開後に時計が進むと生きているロックが起動より前に見える。そうした VM は Linux なので、ID で避けられる。
// - 再起動を挟まない PID の再利用は見分けない。生きているロックと見分ける手段が Node の標準機能に無いため、受け入れる制約にする。
//   ID を引けない OS で、ロックを作った後に時計が1分を超えて進められた場合も、受け入れる制約にする。

// 時刻と起動時刻の比較に持たせる余裕。起動時刻は、秒の切り捨てと時計の補正の分だけずれる。
// 生きているロックを死んだと取り違えると2つのプロセスが同じものを持つので、余裕は、前回の起動のロックを生きていると取り違える側に倒す
// （取り違えても、clone のロックは次の番号へ進み、Issue のロックは PID を再利用したプロセスが終わるまでその Issue を飛ばすだけで済む）
const BOOT_TIME_MARGIN_MS = 60 * 1000

/**
 * ロックファイルに書く中身を作る。
 *
 * @param {{ pid: number, createdAt: Date, bootId: string | null }} holder ロックを持つプロセスの PID・ロックを作った時刻・いまの起動の ID（引けない OS では null）
 * @returns {string} ロックファイルの中身（1行の JSON）
 */
export function buildLockFileContent({ pid, createdAt, bootId }) {
  return `${JSON.stringify({ pid, createdAt: createdAt.toISOString(), bootId })}\n`
}

/**
 * ロックファイルの中身から、持ち主の PID・作った時刻・作った起動の ID を読む。
 *
 * @param {string} lockFileContent ロックファイルの中身
 * @returns {{ pid: number, createdAtMs: number, bootId: string | null } | null} 持ち主（読めない中身なら null）
 */
function parseLockFileContent(lockFileContent) {
  let holder
  try {
    holder = JSON.parse(lockFileContent)
  } catch {
    return null
  }
  const createdAtMs = Date.parse(holder?.createdAt)
  if (!Number.isInteger(holder?.pid) || holder.pid <= 0 || Number.isNaN(createdAtMs)) return null
  return {
    pid: holder.pid,
    createdAtMs,
    bootId: typeof holder.bootId === 'string' ? holder.bootId : null
  }
}

/**
 * ロックファイルの中身から、持ち主の PID を読む。
 *
 * @param {string} lockFileContent ロックファイルの中身
 * @returns {number | null} 持ち主の PID（読めない中身なら null）
 */
export function readLockHolderPid(lockFileContent) {
  return parseLockFileContent(lockFileContent)?.pid ?? null
}

/**
 * ロックがいまの起動より前に作られたかを決める。
 *
 * @param {{ createdAtMs: number, bootId: string | null }} holder ロックの持ち主
 * @param {{ bootedAtMs: number, bootId: string | null }} currentBoot いまの起動の時刻（エポックからのミリ秒）と ID（引けない OS では null）
 * @returns {boolean} 前の起動で作られていれば true
 */
function isCreatedBeforeCurrentBoot(holder, currentBoot) {
  if (holder.bootId !== null && currentBoot.bootId !== null) {
    return holder.bootId !== currentBoot.bootId
  }
  return holder.createdAtMs < currentBoot.bootedAtMs - BOOT_TIME_MARGIN_MS
}

/**
 * ロックが死んでいる（持ち主がもういない）かを決める。
 *
 * 読めない中身は死んだとみなす。ロックファイルは中身を書き終えてから置くので、生きている持ち主のファイルが読めないことは無い。
 * 読めないまま生きているとみなすと、そのロックは誰にも取り直せなくなる。
 *
 * @param {{ lockFileContent: string, isProcessRunning: (pid: number) => boolean, currentBoot: { bootedAtMs: number, bootId: string | null } }} params ロックファイルの中身・PID のプロセスが動いているかを答える関数・いまの起動の時刻（エポックからのミリ秒）と ID（引けない OS では null）
 * @returns {boolean} 死んでいれば true
 */
export function isLockDead({ lockFileContent, isProcessRunning, currentBoot }) {
  const holder = parseLockFileContent(lockFileContent)
  if (holder === null) return true
  if (isCreatedBeforeCurrentBoot(holder, currentBoot)) return true
  return !isProcessRunning(holder.pid)
}

/**
 * 使用中の番号を除いた、1以上で一番小さい番号を選ぶ。
 *
 * 一番小さい空きを取り直すので、番号の数（＝ clone の数）は同時に動かした数の最大値で止まる。
 *
 * @param {Iterable<number>} occupiedNumbers 使用中の番号
 * @returns {number} 空いている番号
 */
export function selectLowestFreeNumber(occupiedNumbers) {
  const occupiedNumberSet = new Set(occupiedNumbers)
  let candidateNumber = 1
  while (occupiedNumberSet.has(candidateNumber)) candidateNumber += 1
  return candidateNumber
}
