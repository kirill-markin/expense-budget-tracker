import type { getLoginFeedback } from "../browserErrors.js";
import type { getConsentTranslations } from "../consent.js";
import type { t } from "../translations.js";

export const login = {
  language: "Dil",
  languageSearch: "Dil ara",
  noLanguageMatches: "Aramanıza uygun dil bulunamadı",
  title: "Oturum aç",
  email: "E-posta adresi",
  sendCode: "Kod gönder",
  sending: "Gönderiliyor…",
  otp: "Doğrulama kodu",
  verify: "Doğrula",
  verifying: "Doğrulanıyor…",
  checkEmail: "8 haneli doğrulama kodu için e-postanızı kontrol edin. Kodu bulamazsanız spam klasörüne bakın.",
} satisfies Record<Parameters<typeof t>[1], string>;

export const feedback = {
  internal_server_error: "Dahili sunucu hatası",
  invalid_request_body: "İstek içeriği geçersiz.",
  invalid_email: "Geçerli bir e-posta adresi girin.",
  demo_sign_in_failed: "Demo oturumu açılamadı",
  send_code_failed: "Kod gönderilemedi. Tekrar deneyin.",
  send_rate_limited: "Çok fazla istek gönderdiniz. Bir süre bekleyip tekrar deneyin.",
  otp_session_expired: "Oturumun süresi doldu. Yeni bir kod isteyin.",
  invalid_otp_code: "8 haneli bir kod girin.",
  verify_code_failed: "Kod doğrulanamadı. Tekrar deneyin.",
  httpError: "Hata: {status}",
} satisfies ReturnType<typeof getLoginFeedback>;

export const consent = {
  title: "Uygulama bağla | Expense Budget Tracker",
  heading: "{clientName} uygulaması Expense Budget Tracker'a bağlansın mı?",
  warningLabel: "Devam etmeden önce:",
  warning: "Ekranda gördüğünüz “{clientName}” adını uygulamanın kendisi bildirdi. Expense Budget Tracker, uygulamayı kimin işlettiğini doğrulamadı. Yalnızca bu bağlantıyı siz başlattıysanız ve aşağıdaki adresi tanıyorsanız devam edin.",
  callbackHeading: "Onay verirseniz döneceğiniz adres",
  destinationNote: "Bu adres, bağlantıyı tanımanıza yardımcı olmak için gösterilir. Adresin gösterilmesi, uygulamayı kimin işlettiğini doğrulamaz.",
  permissionsHeading: "Expense Budget Tracker'daki erişim izinleri",
  permissionsIntro: "Bu uygulama aşağıdaki izinleri istiyor:",
  readLabel: "Okuma izni:",
  readDetails: "Erişebildiğiniz çalışma alanlarındaki tüm finansal verileri görüntüleyebilir.",
  writeLabel: "Yazma izni:",
  writeDetails: "Finansal veri oluşturabilir, değiştirebilir ve silebilir.",
  technicalDetails: "Teknik ayrıntılar",
  clientId: "İstemci kimliği",
  redirectUri: "Tam yönlendirme URI'si",
  resource: "İstenen kaynak",
  allow: "İzin ver",
  deny: "Reddet",
} satisfies ReturnType<typeof getConsentTranslations>["copy"];
