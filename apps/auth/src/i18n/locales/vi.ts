import type { getLoginFeedback } from "../browserErrors.js";
import type { getConsentTranslations } from "../consent.js";
import type { t } from "../translations.js";

export const login = {
  language: "Ngôn ngữ",
  languageSearch: "Tìm ngôn ngữ",
  noLanguageMatches: "Không tìm thấy ngôn ngữ phù hợp",
  title: "Đăng nhập",
  email: "Email",
  sendCode: "Gửi mã",
  sending: "Đang gửi…",
  otp: "Mã xác minh",
  verify: "Xác minh",
  verifying: "Đang xác minh…",
  checkEmail: "Mở email để lấy mã xác minh gồm 8 chữ số. Nếu chưa thấy thư, hãy kiểm tra thư mục thư rác.",
} satisfies Record<Parameters<typeof t>[1], string>;

export const feedback = {
  internal_server_error: "Lỗi nội bộ máy chủ",
  invalid_request_body: "Nội dung yêu cầu không hợp lệ",
  invalid_email: "Địa chỉ email không hợp lệ",
  demo_sign_in_failed: "Không đăng nhập được ở chế độ Demo",
  send_code_failed: "Không gửi được mã. Hãy thử lại.",
  send_rate_limited: "Có quá nhiều yêu cầu. Hãy đợi một lúc rồi thử lại.",
  otp_session_expired: "Phiên đăng nhập đã hết hạn. Hãy yêu cầu mã mới.",
  invalid_otp_code: "Nhập mã xác minh gồm 8 chữ số",
  verify_code_failed: "Không xác minh được mã. Hãy thử lại.",
  httpError: "Lỗi: {status}",
} satisfies ReturnType<typeof getLoginFeedback>;

export const consent = {
  title: "Kết nối ứng dụng | Expense Budget Tracker",
  heading: "Kết nối {clientName} với Expense Budget Tracker?",
  warningLabel: "Trước khi tiếp tục:",
  warning: "Ứng dụng này tự cung cấp tên hiển thị {clientName}. Expense Budget Tracker chưa xác minh ai vận hành ứng dụng. Chỉ tiếp tục nếu chính bạn đã yêu cầu kết nối và nhận ra địa chỉ bên dưới.",
  callbackHeading: "Sau khi cho phép, bạn sẽ được chuyển về",
  destinationNote: "Địa chỉ này giúp bạn nhận ra kết nối. Địa chỉ này không xác nhận danh tính bên vận hành ứng dụng.",
  permissionsHeading: "Quyền truy cập trong Expense Budget Tracker",
  permissionsIntro: "Ứng dụng này yêu cầu các quyền sau:",
  readLabel: "Quyền đọc:",
  readDetails: "Xem toàn bộ dữ liệu tài chính trong các không gian làm việc mà bạn có quyền truy cập.",
  writeLabel: "Quyền ghi:",
  writeDetails: "Tạo, sửa và xóa dữ liệu tài chính.",
  technicalDetails: "Chi tiết kỹ thuật",
  clientId: "Mã định danh ứng dụng khách",
  redirectUri: "URI chuyển hướng đầy đủ",
  resource: "Tài nguyên được yêu cầu",
  allow: "Cho phép",
  deny: "Từ chối",
} satisfies ReturnType<typeof getConsentTranslations>["copy"];
