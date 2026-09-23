/* eslint-disable local/code-comment-notation -- このファイル自身が検査対象トークンを説明のため書くため、ファイル全体で無効化する */

// 責務: code-comment-policy の「記法」節のうち機械で判定できるもの（TODO/FIXMEのIssue番号併記・
// @throwsの型付き記載・@exceptionタグ不使用・重要箇所バナーの個数上限）を検出する自作ESLintルールのみを定義する。

/**
 * @type {import('eslint').Rule.RuleModule}
 */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'code-comment.md が定める記法（TODO/FIXME・@throws・@exception・重要箇所バナー）を検査する'
    },
    schema: [],
    messages: {
      todoNeedsIssueNumber:
        'TODO/FIXME には Issue 番号を "(#番号)" の形式で併記してください（例: TODO(#42): ...）。code-comment.md 参照',
      noExceptionTag: '@exception ではなく @throws を使ってください。code-comment.md 参照',
      throwsNeedsType:
        '@throws には型を書いてください（例: @throws {ValidationError} 説明）。code-comment.md 参照',
      tooManyBanners: '重要箇所バナーは1ファイルに最大1個です。code-comment.md 参照'
    }
  },

  create(context) {
    const sourceCode = context.sourceCode ?? context.getSourceCode()

    // (#数字) が直後に続かない TODO/FIXME だけを拾う。"TODO(#42)" は追跡先ありとして許容する
    const todoWithoutIssueNumber = /\b(?:TODO|FIXME)\b(?!\(#\d+\))/g
    const exceptionTag = /@exception\b/g
    // "{型}" が直後に続かない @throws だけを拾う
    const throwsWithoutType = /@throws\b(?!\s*\{)/g
    // 上段の区切り線〜下段の区切り線までを1つのバナーとして数える
    const bannerBlockPattern =
      /^[ \t]*\/\/[ \t]*═+[ \t]*$\n(?:[ \t]*\/\/[^\n]*\n)*?[ \t]*\/\/[ \t]*═+[ \t]*$/gm

    const reportInComment = (comment, pattern, messageId) => {
      const commentStart = comment.range[0] + 2
      for (const match of comment.value.matchAll(pattern)) {
        const loc = sourceCode.getLocFromIndex(commentStart + match.index)
        context.report({ loc, messageId })
      }
    }

    return {
      Program() {
        for (const comment of sourceCode.getAllComments()) {
          reportInComment(comment, todoWithoutIssueNumber, 'todoNeedsIssueNumber')
          reportInComment(comment, exceptionTag, 'noExceptionTag')
          reportInComment(comment, throwsWithoutType, 'throwsNeedsType')
        }

        const text = sourceCode.getText()
        const banners = [...text.matchAll(bannerBlockPattern)]
        for (const banner of banners.slice(1)) {
          const loc = sourceCode.getLocFromIndex(banner.index)
          context.report({ loc, messageId: 'tooManyBanners' })
        }
      }
    }
  }
}

export default rule
