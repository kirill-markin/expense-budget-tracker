import type { OtpEmailCopy } from "../authEmailCopy.js";

export const signInEmail = {
  subject: "Expense Budget Tracker doğrulama kodunuz",
  headline: "Expense Budget Tracker'da oturum açmaya devam etmek için bu kodu kullanın:",
  expiry: "Bu kodun süresi kısa süre içinde dolacak. Kodu siz istemediyseniz bu e-postayı dikkate almayabilirsiniz.",
} satisfies OtpEmailCopy;
