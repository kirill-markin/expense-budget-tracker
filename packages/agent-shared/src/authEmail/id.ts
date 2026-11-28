import type { OtpEmailCopy } from "../authEmailCopy.js";

export const signInEmail = {
  subject: "Kode verifikasi untuk masuk ke Expense Budget Tracker",
  headline: "Gunakan kode verifikasi berikut untuk masuk ke Expense Budget Tracker:",
  expiry: "Kode ini akan segera kedaluwarsa. Jika Anda tidak meminta kode ini, Anda dapat mengabaikan email ini.",
} satisfies OtpEmailCopy;
