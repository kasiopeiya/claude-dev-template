// 責務: 着手した Issue のカードをボードの「着手中」へ動かし、画面に出す1行を決めることだけを担う。
//   外の世界（gh・設定ファイル）には触らず、呼び出し元（`scripts/move-issue-card.mjs`）から受け取る。
//
// 設計意図（WHY）:
// - どの失敗でも例外にせず、警告の1行を返す。Status は人間が進み具合を見るための表示なので、動かせないことを
//   理由に作業ごと止める方が損が大きい（Issue #1002）。
// - 動かした先の表記は `moveCard` の戻り値から取る。こちらでも持つと、動かした先とメッセージが名乗る先がずれる。
// - I/O を引数で受けることで、gh に触れずに単体テストできる。

const USAGE_MESSAGE = 'Issue 番号を渡してください（例: npm run move-issue-card -- 123）'

// gh が、トークンのスコープ不足で断ったときに出すメッセージ。`gh project` には `project` スコープが要る
const MISSING_SCOPE_PATTERN = /missing required scopes/i

/**
 * 渡された引数が Issue 番号として読めるか。
 *
 * @param {string | undefined} rawIssueNumberArgument コマンドラインから渡された、まだ検証していない引数
 * @returns {boolean} 1 以上の整数として読めれば true
 */
function isIssueNumber(rawIssueNumberArgument) {
  return /^[1-9]\d*$/.test(rawIssueNumberArgument ?? '')
}

/**
 * 2つのリポジトリが同じものを指すか。
 *
 * GitHub は `owner/repo` の大文字小文字を区別しないので、綴りの違いは同じリポジトリとして扱う。
 *
 * @param {string} oneRepository 比べるリポジトリ（`owner/repo`）
 * @param {string} otherRepository 比べる相手のリポジトリ（`owner/repo`）
 * @returns {boolean} 同じリポジトリを指していれば true
 */
function isSameRepository(oneRepository, otherRepository) {
  return oneRepository.toLowerCase() === otherRepository.toLowerCase()
}

/**
 * カードを動かせなかった原因から、人間に出す1行を決める。
 *
 * @param {Error} error カードを動かせなかった原因（gh の失敗・ボードの表記違いなど）
 * @returns {string} 警告として出す1行
 */
function describeMoveFailure(error) {
  if (MISSING_SCOPE_PATTERN.test(error.message)) {
    return `ボードを操作する権限がありません。\`gh auth refresh -s project\` で許可してください: ${error.message}`
  }
  return `カードを動かせませんでした: ${error.message}`
}

/**
 * Issue のカードをボードの「着手中」へ動かし、画面に出す1行を返す。どの失敗でも例外にしない。
 *
 * @param {{ issueNumber: string | undefined, configuredRepository: string, readCurrentRepository: () => string, moveCard: (issueUrl: string) => string }} params
 *   issueNumber: コマンドラインから渡された、まだ検証していない Issue 番号 /
 *   configuredRepository: 設定ファイルが指すリポジトリ（`owner/repo`） /
 *   readCurrentRepository: 今いるリポジトリ（`owner/repo`）を引く /
 *   moveCard: Issue の URL のカードを着手中へ動かし、動かした先の Status の表記を返す
 * @returns {{ message: string, isWarning: boolean }} 画面に出す1行と、それが警告か
 */
export function moveIssueCardToInProgress({
  issueNumber,
  configuredRepository,
  readCurrentRepository,
  moveCard
}) {
  if (!isIssueNumber(issueNumber)) return { message: USAGE_MESSAGE, isWarning: true }

  let movedStatusName
  try {
    const currentRepository = readCurrentRepository()
    if (!isSameRepository(currentRepository, configuredRepository)) {
      return {
        message: `ボードが設定されていないので、カードを動かしません（config.mjs の repository は ${configuredRepository} で、今いるリポジトリは ${currentRepository} です）`,
        isWarning: true
      }
    }
    movedStatusName = moveCard(`https://github.com/${configuredRepository}/issues/${issueNumber}`)
  } catch (error) {
    return { message: describeMoveFailure(error), isWarning: true }
  }

  return {
    message: `#${issueNumber} のカードを ${movedStatusName} へ動かしました`,
    isWarning: false
  }
}
