import type { getLoginFeedback } from "../browserErrors.js";
import type { getConsentTranslations } from "../consent.js";
import type { t } from "../translations.js";

export const login = {
  language: "Langue",
  languageSearch: "Rechercher une langue",
  noLanguageMatches: "Aucune langue trouvée",
  title: "Se connecter",
  email: "Adresse e-mail",
  sendCode: "Envoyer le code",
  sending: "Envoi en cours…",
  otp: "Code de vérification",
  verify: "Vérifier",
  verifying: "Vérification en cours…",
  checkEmail: "Consultez votre boîte de réception pour trouver le code à 8 chiffres. Si le message n’y est pas, vérifiez vos courriers indésirables.",
} satisfies Record<Parameters<typeof t>[1], string>;

export const feedback = {
  internal_server_error: "Erreur interne du serveur",
  invalid_request_body: "La demande est mal formatée",
  invalid_email: "Adresse e-mail non valide",
  demo_sign_in_failed: "Impossible de se connecter en mode démo",
  send_code_failed: "Impossible d’envoyer le code. Réessayez.",
  send_rate_limited: "Trop de demandes de code. Patientez avant de réessayer.",
  otp_session_expired: "La session a expiré. Demandez un nouveau code.",
  invalid_otp_code: "Saisissez un code à 8 chiffres",
  verify_code_failed: "Impossible de vérifier le code. Réessayez.",
  httpError: "Erreur : {status}",
} satisfies ReturnType<typeof getLoginFeedback>;

export const consent = {
  title: "Connecter une application | Expense Budget Tracker",
  heading: "Connecter {clientName} à Expense Budget Tracker ?",
  warningLabel: "Avant de continuer :",
  warning: "Le nom affiché, « {clientName} », a été fourni par l’application. Expense Budget Tracker n’a pas vérifié qui gère cette application. Continuez uniquement si vous avez lancé cette connexion et si vous reconnaissez la destination ci-dessous.",
  callbackHeading: "Destination après autorisation",
  destinationNote: "Cette destination vous aide à reconnaître la demande de connexion. Elle ne permet pas de vérifier qui gère l’application.",
  permissionsHeading: "Autorisations dans Expense Budget Tracker",
  permissionsIntro: "Cette application demande les autorisations suivantes :",
  readLabel: "Accès en lecture :",
  readDetails: "Consulter toutes les données financières des espaces de travail auxquels vous avez accès.",
  writeLabel: "Accès en écriture :",
  writeDetails: "Créer, modifier et supprimer des données financières.",
  technicalDetails: "Détails techniques",
  clientId: "Identifiant du client",
  redirectUri: "URI de redirection exacte",
  resource: "Ressource demandée",
  allow: "Autoriser",
  deny: "Refuser",
} satisfies ReturnType<typeof getConsentTranslations>["copy"];
