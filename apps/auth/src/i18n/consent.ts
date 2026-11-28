import { DEFAULT_LOCALE, type SupportedLocale } from "@expense-budget-tracker/agent-shared/locales";

const englishConsent = {
  title: "Connect an app | Expense Budget Tracker",
  heading: "Connect {clientName} to Expense Budget Tracker?",
  warningLabel: "Before you continue:",
  warning: "The connecting app supplied the displayed name {clientName}. Expense Budget Tracker has not verified who operates it. Continue only if you started this connection and recognize the destination below.",
  callbackHeading: "After approval, you'll return to",
  destinationNote: "This destination is shown to help you recognize the connection. It does not verify who operates the app.",
  permissionsHeading: "Access in Expense Budget Tracker",
  permissionsIntro: "This app is asking for the following access:",
  readLabel: "Read access:",
  readDetails: "View all financial data in the workspaces you can access.",
  writeLabel: "Write access:",
  writeDetails: "Create, change, and delete financial data.",
  technicalDetails: "Technical details",
  clientId: "Client ID",
  redirectUri: "Exact redirect URI",
  resource: "Requested resource",
  allow: "Allow",
  deny: "Deny",
};

type ConsentTranslations = Readonly<Record<keyof typeof englishConsent, string>>;

const consentTranslations: Readonly<Partial<Record<SupportedLocale, ConsentTranslations>>> = {
  en: englishConsent,
};

export const getConsentTranslations = (locale: SupportedLocale): Readonly<{
  locale: SupportedLocale;
  copy: ConsentTranslations;
}> => {
  const copy = consentTranslations[locale];
  return copy === undefined ? { locale: DEFAULT_LOCALE, copy: englishConsent } : { locale, copy };
};
