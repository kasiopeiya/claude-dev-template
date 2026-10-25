// 責務: pid のプロセスが生きているかを確かめることのみを担う。

/**
 * プロセスが生きているかを返す。
 *
 * @param {number} pid 調べるプロセスの pid
 * @returns {boolean} 生きていれば true。シグナルを送る権限が無いだけ（EPERM）のときも、存在はするので true
 */
export function isProcessAlive(pid) {
  try {
    // シグナル 0 は届くかだけを確かめ、プロセスには何もしない
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}
