import type { OtpEmailCopy } from "../authEmailCopy.js";

export const signInEmail = {
  subject: "Expense Budget Tracker のログイン用確認コード",
  headline: "Expense Budget Tracker にログインするには、以下の確認コードを入力してください。",
  expiry: "このコードはまもなく有効期限が切れます。コードをリクエストした覚えがなければ、このメールは無視してかまいません。",
} satisfies OtpEmailCopy;
