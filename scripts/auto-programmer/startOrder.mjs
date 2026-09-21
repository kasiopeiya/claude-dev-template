// 責務: 着手待ちの候補から、いま着手できる Issue を着手順に並べる純粋関数だけを担う。
//
// 設計意図（WHY）:
// - 着手できるかは段番号ではなく、ブロッカーの state の実測で決める。段番号は人間が
//   `/issue-deps` を回した時点の見立てで、古い可能性がある（Issue #481）。段番号は順序にだけ使う。
// - 本文とタイトルの書式は `.claude/skills/issue-deps/SKILL.md` が書き込む形が正。
// - I/O を持たない層をここに切り出すことで、GitHub に触れずに単体テストできる。

const BLOCKER_SECTION_HEADING = '## ブロッカー'

// ブロッカー節の1行。行頭の番号だけを採り、説明文の中の #番号 は拾わない
const BLOCKER_LINE_PATTERN = /^\s*[-*+]\s+#(\d+)/

// 箇条書きの行。ブロッカー節でこれに当たるのに番号を読めない行は、書式の崩れとみなす
const LIST_ITEM_PATTERN = /^\s*(?:[-*+]|\d+\.)\s/

// タイトル先頭の段番号。`N〜M. ` は open な子を持つ親の範囲で、子のうち最も早い段 N から
// 並行して着手できる。親を子と同じ段に並べるため、小さいほうの N を採る
const STAGE_NUMBER_PATTERN = /^(\d+)(?:〜\d+)?\.\s/

/**
 * 本文から、コードブロックの外にある `## ブロッカー` 節の行だけを取り出す。
 *
 * @param {string} body Issue 本文
 * @returns {string[] | null} 節の見出しより後、次の節より前の行（節が無ければ null）
 */
function readBlockerSectionLines(body) {
  let isInCodeBlock = false
  let sectionLines = null
  for (const line of body.split('\n')) {
    if (line.trimStart().startsWith('```')) isInCodeBlock = !isInCodeBlock
    if (isInCodeBlock) continue
    if (sectionLines && line.startsWith('## ')) break
    if (sectionLines) sectionLines.push(line)
    else if (line.trim() === BLOCKER_SECTION_HEADING) sectionLines = []
  }
  return sectionLines
}

/**
 * Issue 本文の `## ブロッカー` 節から、ブロッカーの Issue 番号を取り出す。
 *
 * 節の中に番号を読めない箇条書きの行があれば null を返す。読めないブロッカーを
 * 「無い」と取り違えて、未完の依存先を待たずに着手しないためである。
 *
 * @param {string | undefined} body Issue 本文
 * @returns {number[] | null} ブロッカーの Issue 番号（節が無ければ空配列、読めない行があれば null）
 */
export function extractBlockerIssueNumbers(body) {
  const sectionLines = readBlockerSectionLines(body ?? '')
  if (!sectionLines) return []

  const blockerNumbers = []
  for (const line of sectionLines) {
    const matched = BLOCKER_LINE_PATTERN.exec(line)
    if (matched) blockerNumbers.push(Number(matched[1]))
    else if (LIST_ITEM_PATTERN.test(line)) return null
  }
  return blockerNumbers
}

/**
 * タイトル先頭の段番号を読む。
 *
 * @param {string} title Issue タイトル
 * @returns {number} 段番号（無ければ Infinity で、段番号のある Issue より後に並ぶ）
 */
function readStageNumber(title) {
  const matched = STAGE_NUMBER_PATTERN.exec(title)
  return matched ? Number(matched[1]) : Infinity
}

/**
 * 未解消のブロッカーが残っておらず、ブロッカー節を読める候補だけを、段番号昇順 → Issue 番号昇順に並べて返す。
 *
 * @template {{ number: number, title: string, body?: string }} Candidate
 * @param {Candidate[]} candidates 着手待ちの候補
 * @param {Set<number>} unresolvedBlockerNumbers closed だと確かめられなかった Issue 番号
 * @returns {Candidate[]} 着手できる候補を着手順に並べたもの
 */
export function selectStartableIssues(candidates, unresolvedBlockerNumbers) {
  return candidates
    .filter((candidate) => {
      const blockerNumbers = extractBlockerIssueNumbers(candidate.body)
      return (
        blockerNumbers !== null &&
        blockerNumbers.every((blockerNumber) => !unresolvedBlockerNumbers.has(blockerNumber))
      )
    })
    .sort((a, b) => readStageNumber(a.title) - readStageNumber(b.title) || a.number - b.number)
}
