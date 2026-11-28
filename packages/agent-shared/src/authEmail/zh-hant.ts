import type { OtpEmailCopy } from "../authEmailCopy.js";

export const signInEmail = {
  subject: "你的 Expense Budget Tracker 登入驗證碼",
  headline: "請輸入以下驗證碼，繼續登入 Expense Budget Tracker：",
  expiry: "驗證碼即將失效。若你沒有索取這組驗證碼，可以忽略這封郵件。",
} satisfies OtpEmailCopy;
