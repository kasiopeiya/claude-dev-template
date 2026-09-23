---
paths:
  - 'app/**/*.ts'
  - 'app/**/*.tsx'
  - 'samples/app/**/*.ts'
  - 'samples/app/**/*.tsx'
---

# 構造化ログの書き方

ログの**思想**（いつ・何を・どのレベルで出すか）は [application-logging-policy.md](../../docs/policy/application-logging-policy.md) が定める。ここでは、それを踏まえた**書き方（How）**だけを定める。

## 対象読者

AIエージェントが、ログ出力のコードを実装・レビューし、JSON構造化・メッセージ文字列とフィールドの分離の書き方に迷ったとき。

## 構造化ログ（JSON形式）を使う

ログはメッセージ文字列とフィールドを分離した構造化（JSON）形式で出力する。メッセージ文字列はイベントの種類を表す固定文言にし、IDや可変値はフィールドに分離する。固定文言で絞り込み、フィールドで詳細を確認できる構造になり、人間が読むフリーテキストよりも CloudWatch Logs Insights 等での検索・集計・フィルタが容易になる。

```typescript
// ❌ フリーテキスト（メッセージに可変値を埋め込み、検索・集計が困難）
logger.error(`orderId=${orderId} の決済処理が失敗しました: ${err.message}`)

// ✅ 構造化（固定メッセージ＋フィールドで検索・集計できる）
logger.error('決済処理が失敗しました', {
  errorCode: 'PAY_001',
  orderId,
  userId,
  error: err.message
})
```
