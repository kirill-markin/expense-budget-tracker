import type { getLoginFeedback } from "../browserErrors.js";
import type { getConsentTranslations } from "../consent.js";
import type { t } from "../translations.js";

export const login = {
  language: "언어",
  languageSearch: "언어 검색",
  noLanguageMatches: "일치하는 언어가 없습니다.",
  title: "로그인",
  email: "이메일",
  sendCode: "인증 코드 보내기",
  sending: "보내는 중…",
  otp: "인증 코드",
  verify: "코드 확인",
  verifying: "확인 중…",
  checkEmail: "이메일로 받은 8자리 인증 코드를 확인하세요. 메일이 보이지 않으면 스팸함도 확인하세요.",
} satisfies Record<Parameters<typeof t>[1], string>;

export const feedback = {
  internal_server_error: "서버 내부 오류가 발생했습니다.",
  invalid_request_body: "요청 형식이 올바르지 않습니다.",
  invalid_email: "올바른 이메일 주소를 입력하세요.",
  demo_sign_in_failed: "데모 로그인에 실패했습니다.",
  send_code_failed: "인증 코드를 보내지 못했습니다. 다시 시도하세요.",
  send_rate_limited: "요청이 너무 많습니다. 잠시 후 다시 시도하세요.",
  otp_session_expired: "인증할 수 있는 시간이 지났습니다. 새 인증 코드를 요청하세요.",
  invalid_otp_code: "인증 코드 8자리를 입력하세요.",
  verify_code_failed: "인증에 실패했습니다. 다시 시도하세요.",
  httpError: "오류: {status}",
} satisfies ReturnType<typeof getLoginFeedback>;

export const consent = {
  title: "앱 연결 | Expense Budget Tracker",
  heading: "‘{clientName}’ 앱을 Expense Budget Tracker에 연결할까요?",
  warningLabel: "계속하기 전에 확인하세요.",
  warning: "화면에 표시된 이름({clientName})은 연결을 요청한 앱에서 제공했습니다. Expense Budget Tracker는 이 앱의 운영자를 확인하지 않았습니다. 직접 연결을 시작했고 아래 주소를 알고 있는 경우에만 계속하세요.",
  callbackHeading: "승인 후 돌아갈 주소",
  destinationNote: "표시된 주소는 어떤 연결인지 확인하는 데 도움이 됩니다. 주소만으로는 앱 운영자를 확인할 수 없습니다.",
  permissionsHeading: "Expense Budget Tracker 접근 권한",
  permissionsIntro: "이 앱이 다음 권한을 요청합니다.",
  readLabel: "읽기 권한:",
  readDetails: "사용자가 접근할 수 있는 워크스페이스의 모든 재무 데이터를 볼 수 있습니다.",
  writeLabel: "쓰기 권한:",
  writeDetails: "재무 데이터를 생성·수정·삭제할 수 있습니다.",
  technicalDetails: "기술 세부 정보",
  clientId: "클라이언트 ID",
  redirectUri: "전체 리디렉션 URI",
  resource: "요청한 리소스",
  allow: "허용",
  deny: "거부",
} satisfies ReturnType<typeof getConsentTranslations>["copy"];
