import type { OtpEmailCopy } from "../authEmailCopy.js";

export const signInEmail = {
  subject: "Votre code de vérification pour Expense Budget Tracker",
  headline: "Saisissez ce code pour vous connecter à Expense Budget Tracker :",
  expiry: "Ce code expire bientôt. Si vous ne l’avez pas demandé, vous pouvez ignorer ce message.",
} satisfies OtpEmailCopy;
