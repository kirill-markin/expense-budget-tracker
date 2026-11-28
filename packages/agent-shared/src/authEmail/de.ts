import type { OtpEmailCopy } from "../authEmailCopy.js";

export const signInEmail = {
  subject: "Dein Bestätigungscode für Expense Budget Tracker",
  headline: "Gib diesen Bestätigungscode ein, um dich bei Expense Budget Tracker anzumelden:",
  expiry: "Dieser Code läuft in Kürze ab. Wenn du ihn nicht angefordert hast, kannst du diese E-Mail ignorieren.",
} satisfies OtpEmailCopy;
