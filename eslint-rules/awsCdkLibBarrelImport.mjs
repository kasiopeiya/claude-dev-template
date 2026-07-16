// 責務: aws-cdk-lib のサービスモジュール import を barrel 形式へ統一させる自作 ESLint ルールのみを定義する（cdk.md）

/**
 * `aws-cdk-lib/aws-<service>` からのサブモジュール import を検出し、
 * `import { aws_<service> as <local> } from 'aws-cdk-lib'` の barrel 形式へ寄せる。
 *
 * - 名前空間 import（`import * as s3 from 'aws-cdk-lib/aws-s3'`）は、
 *   ローカル名を保てるため自動修正（fixer）で barrel 形式へ書き換える。
 * - 名前付き import（`import { Bucket } from 'aws-cdk-lib/aws-s3'`）は、
 *   使用箇所（`Bucket` → `s3.Bucket`）の書き換えを伴い自動修正が非安全なため、
 *   検出のみ行い自動修正はしない。
 *
 * @type {import('eslint').Rule.RuleModule}
 */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        "aws-cdk-lib のサービスモジュールは import { aws_x as x } from 'aws-cdk-lib' の barrel 形式に統一する（cdk.md）"
    },
    fixable: 'code',
    schema: [],
    messages: {
      // 単一の波括弧はリテラル。ESLint が補間するのは {{name}} / {{local}} のみ
      useBarrelNamespace:
        "aws-cdk-lib のサービスモジュールは import { {{name}} as {{local}} } from 'aws-cdk-lib' の形式に統一してください（cdk.md）。",
      useBarrelNamed:
        "aws-cdk-lib のサービスモジュールは 'aws-cdk-lib' からの barrel import（例: import { aws_s3 as s3 } from 'aws-cdk-lib'）に統一してください（cdk.md）。使用箇所の書き換えを伴うため自動修正は行いません。"
    }
  },

  create(context) {
    // aws-cdk-lib/aws-s3, aws-cdk-lib/aws-lambda-nodejs など「サービスモジュール」だけを対象にする。
    // aws-cdk-lib/assertions のような非サービスモジュールは cdk.md の対象外なので除外する。
    const cdkServiceSubmodule = /^aws-cdk-lib\/(aws-[A-Za-z0-9-]+)$/

    return {
      ImportDeclaration(node) {
        const source = node.source.value
        if (typeof source !== 'string') return

        const matched = cdkServiceSubmodule.exec(source)
        if (matched === null) return

        // aws-s3 → aws_s3（barrel が公開する名前空間名はハイフンをアンダースコアにしたもの）
        const barrelName = matched[1].replace(/-/g, '_')

        const namespaceSpecifier = node.specifiers.find(
          (specifier) => specifier.type === 'ImportNamespaceSpecifier'
        )
        const isPureNamespaceImport =
          namespaceSpecifier !== undefined && node.specifiers.length === 1

        if (isPureNamespaceImport) {
          const localName = namespaceSpecifier.local.name
          context.report({
            node,
            messageId: 'useBarrelNamespace',
            data: { name: barrelName, local: localName },
            fix(fixer) {
              return fixer.replaceText(
                node,
                `import { ${barrelName} as ${localName} } from 'aws-cdk-lib'`
              )
            }
          })
          return
        }

        context.report({ node, messageId: 'useBarrelNamed' })
      }
    }
  }
}

export default rule
