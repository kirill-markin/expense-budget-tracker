import type { OtpEmailCopy } from "../authEmailCopy.js";

export const signInEmail = {
  subject: "Codice di verifica per accedere a Expense Budget Tracker",
  headline: "Usa questo codice per accedere a Expense Budget Tracker.",
  expiry: "Il codice scadrà tra poco. Se non l’hai richiesto, puoi ignorare questa email.",
} satisfies OtpEmailCopy;
