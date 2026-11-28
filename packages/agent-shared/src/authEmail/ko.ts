import type { OtpEmailCopy } from "../authEmailCopy.js";

export const signInEmail = {
  subject: "Expense Budget Tracker 로그인 인증 코드",
  headline: "Expense Budget Tracker에 로그인하려면 아래 인증 코드를 입력하세요.",
  expiry: "인증 코드가 곧 만료됩니다. 이 코드를 요청하지 않았다면 메일을 무시해도 됩니다.",
} satisfies OtpEmailCopy;
