import type { OtpEmailCopy } from "../authEmailCopy.js";

export const signInEmail = {
  subject: "Mã xác minh để đăng nhập vào Expense Budget Tracker",
  headline: "Nhập mã sau để tiếp tục đăng nhập vào Expense Budget Tracker:",
  expiry: "Mã này sắp hết hạn. Bạn có thể bỏ qua email này nếu không yêu cầu mã.",
} satisfies OtpEmailCopy;
