import type { getLoginFeedback } from "../browserErrors.js";
import type { getConsentTranslations } from "../consent.js";
import type { t } from "../translations.js";

export const login = {
  language: "語言",
  languageSearch: "搜尋語言",
  noLanguageMatches: "找不到符合的語言",
  title: "登入",
  email: "電子郵件",
  sendCode: "傳送驗證碼",
  sending: "傳送中…",
  otp: "驗證碼",
  verify: "驗證",
  verifying: "驗證中…",
  checkEmail: "請查收電子郵件中的 8 位數驗證碼。若未收到，請查看垃圾郵件。",
} satisfies Record<Parameters<typeof t>[1], string>;

export const feedback = {
  internal_server_error: "伺服器發生內部錯誤",
  invalid_request_body: "請求內容無效",
  invalid_email: "電子郵件地址無效",
  demo_sign_in_failed: "無法登入示範模式",
  send_code_failed: "無法傳送驗證碼，請重試",
  send_rate_limited: "請求次數過多，請稍候再試",
  otp_session_expired: "登入驗證已逾時，請重新索取驗證碼",
  invalid_otp_code: "請輸入 8 位數的驗證碼",
  verify_code_failed: "驗證失敗，請重試",
  httpError: "錯誤：{status}",
} satisfies ReturnType<typeof getLoginFeedback>;

export const consent = {
  title: "連接應用程式 | Expense Budget Tracker",
  heading: "要將 {clientName} 連接至 Expense Budget Tracker 嗎？",
  warningLabel: "繼續之前，請留意：",
  warning: "顯示的名稱「{clientName}」由要求連線的應用程式提供。Expense Budget Tracker 未驗證該應用程式由誰營運。只有在你主動發起這次連線，而且認得下方的目的地時，才應繼續。",
  callbackHeading: "授權後，你將返回以下位置",
  destinationNote: "此處顯示目的地，方便你辨認這次連線。目的地無法證明應用程式營運者的身分。",
  permissionsHeading: "存取 Expense Budget Tracker 的權限",
  permissionsIntro: "此應用程式要求下列權限：",
  readLabel: "讀取權限：",
  readDetails: "查看你有權存取的工作空間內的所有財務資料。",
  writeLabel: "寫入權限：",
  writeDetails: "新增、修改及刪除財務資料。",
  technicalDetails: "技術詳情",
  clientId: "用戶端 ID",
  redirectUri: "確切的重新導向 URI",
  resource: "要求存取的資源",
  allow: "允許",
  deny: "拒絕",
} satisfies ReturnType<typeof getConsentTranslations>["copy"];
