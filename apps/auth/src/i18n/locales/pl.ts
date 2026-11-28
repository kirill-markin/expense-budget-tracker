import type { getLoginFeedback } from "../browserErrors.js";
import type { getConsentTranslations } from "../consent.js";
import type { t } from "../translations.js";

export const login = {
  language: "Język",
  languageSearch: "Szukaj języków",
  noLanguageMatches: "Brak pasujących języków",
  title: "Zaloguj się",
  email: "Adres e-mail",
  sendCode: "Wyślij kod",
  sending: "Wysyłanie…",
  otp: "Kod weryfikacyjny",
  verify: "Zweryfikuj kod",
  verifying: "Weryfikowanie…",
  checkEmail: "Wysłaliśmy 8-cyfrowy kod weryfikacyjny. Sprawdź pocztę. Jeśli nie widzisz wiadomości, zajrzyj do folderu ze spamem.",
} satisfies Record<Parameters<typeof t>[1], string>;

export const feedback = {
  internal_server_error: "Wewnętrzny błąd serwera",
  invalid_request_body: "Nieprawidłowa treść żądania",
  invalid_email: "Nieprawidłowy adres e-mail",
  demo_sign_in_failed: "Nie udało się zalogować w trybie demo",
  send_code_failed: "Nie udało się wysłać kodu. Spróbuj ponownie.",
  send_rate_limited: "Zbyt wiele prób. Odczekaj chwilę i spróbuj ponownie.",
  otp_session_expired: "Sesja wygasła. Poproś o nowy kod.",
  invalid_otp_code: "Wpisz 8-cyfrowy kod weryfikacyjny",
  verify_code_failed: "Nie udało się zweryfikować kodu. Spróbuj ponownie.",
  httpError: "Błąd: {status}",
} satisfies ReturnType<typeof getLoginFeedback>;

export const consent = {
  title: "Połącz aplikację | Expense Budget Tracker",
  heading: "Połączyć aplikację „{clientName}” z Expense Budget Tracker?",
  warningLabel: "Zanim przejdziesz dalej:",
  warning: "Aplikacja sama podała wyświetlaną nazwę „{clientName}”. Expense Budget Tracker nie zweryfikował, kto nią zarządza. Kontynuuj tylko wtedy, gdy to Ty inicjujesz połączenie i rozpoznajesz poniższy adres.",
  callbackHeading: "Po udzieleniu dostępu nastąpi przekierowanie pod ten adres",
  destinationNote: "Ten adres pomoże Ci rozpoznać połączenie. Nie potwierdza, kto zarządza aplikacją.",
  permissionsHeading: "Dostęp w Expense Budget Tracker",
  permissionsIntro: "Aplikacja prosi o następujące uprawnienia:",
  readLabel: "Odczyt danych:",
  readDetails: "Wyświetlanie wszystkich danych finansowych w obszarach roboczych, do których masz dostęp.",
  writeLabel: "Zapis danych:",
  writeDetails: "Tworzenie, zmienianie i usuwanie danych finansowych.",
  technicalDetails: "Szczegóły techniczne",
  clientId: "Identyfikator klienta",
  redirectUri: "Dokładny adres URI przekierowania",
  resource: "Żądany zasób",
  allow: "Zezwól",
  deny: "Odmów",
} satisfies ReturnType<typeof getConsentTranslations>["copy"];
