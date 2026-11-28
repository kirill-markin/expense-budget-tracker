import type { OtpEmailCopy } from "../authEmailCopy.js";

export const signInEmail = {
  subject: "Seu código para entrar no Expense Budget Tracker",
  headline: "Digite este código de verificação para continuar no Expense Budget Tracker:",
  expiry: "O código expira em breve. Se não solicitou o código, pode ignorar este e-mail.",
} satisfies OtpEmailCopy;
