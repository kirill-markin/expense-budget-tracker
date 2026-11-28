import type { OtpEmailCopy } from "../authEmailCopy.js";

export const signInEmail = {
  subject: "Kod weryfikacyjny do logowania w Expense Budget Tracker",
  headline: "Aby kontynuować logowanie w Expense Budget Tracker, wpisz poniższy kod:",
  expiry: "Kod wkrótce wygaśnie. Jeśli prośba o kod nie pochodzi od Ciebie, możesz zignorować tę wiadomość.",
} satisfies OtpEmailCopy;
