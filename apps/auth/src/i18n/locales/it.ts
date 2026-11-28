import type { getLoginFeedback } from "../browserErrors.js";
import type { getConsentTranslations } from "../consent.js";
import type { t } from "../translations.js";

export const login = {
  language: "Lingua",
  languageSearch: "Cerca una lingua",
  noLanguageMatches: "Nessuna lingua trovata",
  title: "Accedi",
  email: "Email",
  sendCode: "Invia il codice",
  sending: "Invio in corso…",
  otp: "Codice di verifica",
  verify: "Verifica",
  verifying: "Verifica in corso…",
  checkEmail: "Cerca nella posta il codice di verifica a 8 cifre. Se non trovi il messaggio, controlla la cartella spam.",
} satisfies Record<Parameters<typeof t>[1], string>;

export const feedback = {
  internal_server_error: "Errore interno del server",
  invalid_request_body: "Formato della richiesta non valido",
  invalid_email: "Indirizzo email non valido",
  demo_sign_in_failed: "Accesso alla demo non riuscito",
  send_code_failed: "Impossibile inviare il codice. Riprova.",
  send_rate_limited: "Troppe richieste. Aspetta prima di riprovare.",
  otp_session_expired: "Sessione scaduta. Richiedi un nuovo codice.",
  invalid_otp_code: "Inserisci un codice a 8 cifre",
  verify_code_failed: "Verifica non riuscita. Riprova.",
  httpError: "Errore ({status})",
} satisfies ReturnType<typeof getLoginFeedback>;

export const consent = {
  title: "Collega un’app | Expense Budget Tracker",
  heading: "Vuoi collegare {clientName} a Expense Budget Tracker?",
  warningLabel: "Controlla il collegamento prima di continuare.",
  warning: "Il nome visualizzato ({clientName}) è stato fornito dall’app. Expense Budget Tracker non ha verificato chi la gestisce. Continua solo se hai avviato tu il collegamento e riconosci la destinazione qui sotto.",
  callbackHeading: "Dopo aver autorizzato il collegamento, tornerai a",
  destinationNote: "La destinazione ti aiuta a riconoscere il collegamento. Non conferma chi gestisce l’app.",
  permissionsHeading: "Accesso a Expense Budget Tracker",
  permissionsIntro: "L’app chiede questi permessi.",
  readLabel: "Con l’accesso in lettura, l’app può",
  readDetails: "vedere tutti i dati finanziari negli spazi di lavoro a cui hai accesso.",
  writeLabel: "Con l’accesso in scrittura, l’app può",
  writeDetails: "creare, modificare ed eliminare dati finanziari.",
  technicalDetails: "Dettagli tecnici",
  clientId: "ID del client",
  redirectUri: "URI esatto di reindirizzamento",
  resource: "Risorsa richiesta",
  allow: "Consenti",
  deny: "Nega",
} satisfies ReturnType<typeof getConsentTranslations>["copy"];
