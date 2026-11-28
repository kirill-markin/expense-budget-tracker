import type { getLoginFeedback } from "../browserErrors.js";
import type { getConsentTranslations } from "../consent.js";
import type { t } from "../translations.js";

export const login = {
  language: "Sprache",
  languageSearch: "Sprachen suchen",
  noLanguageMatches: "Keine passenden Sprachen gefunden",
  title: "Anmelden",
  email: "E-Mail-Adresse",
  sendCode: "Code senden",
  sending: "Wird gesendet…",
  otp: "Bestätigungscode",
  verify: "Code bestätigen",
  verifying: "Wird geprüft…",
  checkEmail: "Schau im Posteingang nach dem 8-stelligen Bestätigungscode. Falls du die E-Mail nicht findest, prüfe den Spamordner.",
} satisfies Record<Parameters<typeof t>[1], string>;

export const feedback = {
  internal_server_error: "Interner Serverfehler",
  invalid_request_body: "Ungültige Anfragedaten",
  invalid_email: "Ungültige E-Mail-Adresse",
  demo_sign_in_failed: "Die Anmeldung im Demo-Modus ist fehlgeschlagen",
  send_code_failed: "Der Code konnte nicht gesendet werden. Versuch es erneut.",
  send_rate_limited: "Zu viele Anfragen. Warte etwas und versuch es erneut.",
  otp_session_expired: "Die Sitzung ist abgelaufen. Fordere einen neuen Code an.",
  invalid_otp_code: "Gib einen 8-stelligen Code ein",
  verify_code_failed: "Der Code konnte nicht bestätigt werden. Versuch es erneut.",
  httpError: "Fehler: {status}",
} satisfies ReturnType<typeof getLoginFeedback>;

export const consent = {
  title: "App verbinden | Expense Budget Tracker",
  heading: "{clientName} mit Expense Budget Tracker verbinden?",
  warningLabel: "Bevor du fortfährst:",
  warning: "Die App hat den Namen {clientName} selbst angegeben. Expense Budget Tracker hat nicht geprüft, wer die App betreibt. Fahre nur fort, wenn du die Verbindung selbst gestartet hast und das unten angegebene Ziel wiedererkennst.",
  callbackHeading: "Nach deiner Zustimmung wirst du hierhin zurückgeleitet:",
  destinationNote: "Das Weiterleitungsziel hilft dir, die Verbindung wiederzuerkennen. Es ist kein Nachweis dafür, wer die App betreibt.",
  permissionsHeading: "Zugriff in Expense Budget Tracker",
  permissionsIntro: "Die App fordert folgende Berechtigungen an:",
  readLabel: "Lesezugriff:",
  readDetails: "Alle Finanzdaten in den Arbeitsbereichen einsehen, auf die du Zugriff hast.",
  writeLabel: "Schreibzugriff:",
  writeDetails: "Finanzdaten erstellen, ändern und löschen.",
  technicalDetails: "Technische Details",
  clientId: "Client-ID",
  redirectUri: "Vollständige Weiterleitungs-URI",
  resource: "Angeforderte Ressource",
  allow: "Zulassen",
  deny: "Ablehnen",
} satisfies ReturnType<typeof getConsentTranslations>["copy"];
