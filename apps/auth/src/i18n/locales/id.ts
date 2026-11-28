import type { getLoginFeedback } from "../browserErrors.js";
import type { getConsentTranslations } from "../consent.js";
import type { t } from "../translations.js";

export const login = {
  language: "Bahasa",
  languageSearch: "Cari bahasa",
  noLanguageMatches: "Tidak ada bahasa yang cocok",
  title: "Masuk",
  email: "Email",
  sendCode: "Kirim kode",
  sending: "Mengirim…",
  otp: "Kode verifikasi",
  verify: "Verifikasi",
  verifying: "Memverifikasi…",
  checkEmail: "Cari kode verifikasi 8 digit di email Anda. Jika pesannya tidak ada, periksa folder spam.",
} satisfies Record<Parameters<typeof t>[1], string>;

export const feedback = {
  internal_server_error: "Terjadi kesalahan internal pada server",
  invalid_request_body: "Isi permintaan tidak valid",
  invalid_email: "Alamat email tidak valid",
  demo_sign_in_failed: "Gagal masuk ke mode Demo",
  send_code_failed: "Kode gagal dikirim. Coba lagi.",
  send_rate_limited: "Terlalu banyak permintaan. Tunggu sebelum mencoba lagi.",
  otp_session_expired: "Sesi telah kedaluwarsa. Minta kode baru.",
  invalid_otp_code: "Masukkan kode verifikasi 8 digit",
  verify_code_failed: "Verifikasi gagal. Coba lagi.",
  httpError: "Kesalahan: {status}",
} satisfies ReturnType<typeof getLoginFeedback>;

export const consent = {
  title: "Hubungkan aplikasi | Expense Budget Tracker",
  heading: "Hubungkan {clientName} ke Expense Budget Tracker?",
  warningLabel: "Sebelum melanjutkan:",
  warning: "Aplikasi yang meminta koneksi ini memberikan nama {clientName} yang ditampilkan. Expense Budget Tracker belum memverifikasi identitas pengelola aplikasi tersebut. Lanjutkan hanya jika Anda yang memulai koneksi ini dan mengenali tujuan di bawah.",
  callbackHeading: "Setelah memberi izin, Anda akan diarahkan kembali ke",
  destinationNote: "Tujuan ini ditampilkan agar Anda dapat mengenali koneksi tersebut. Tujuan ini tidak membuktikan identitas pengelola aplikasi.",
  permissionsHeading: "Akses di Expense Budget Tracker",
  permissionsIntro: "Aplikasi ini meminta akses berikut:",
  readLabel: "Akses baca:",
  readDetails: "Melihat semua data keuangan di ruang kerja yang dapat Anda akses.",
  writeLabel: "Akses tulis:",
  writeDetails: "Membuat, mengubah, dan menghapus data keuangan.",
  technicalDetails: "Detail teknis",
  clientId: "ID klien",
  redirectUri: "URI pengalihan lengkap",
  resource: "Sumber daya yang diminta",
  allow: "Izinkan",
  deny: "Tolak",
} satisfies ReturnType<typeof getConsentTranslations>["copy"];
