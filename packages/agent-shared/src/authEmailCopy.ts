import { DEFAULT_LOCALE, type SupportedLocale } from "./locales.js";

export type OtpEmailCopy = Readonly<{
  subject: string;
  headline: string;
  expiry: string;
}>;

const englishOtpExpiry = "This code expires soon. If you did not request it, you can ignore this email.";

export const ENGLISH_AUTH_EMAIL_COPY = {
  signIn: {
    subject: "Your Expense Budget Tracker sign-in code",
    headline: "Use this sign-in code to continue in Expense Budget Tracker:",
    expiry: englishOtpExpiry,
  },
  passwordReset: {
    subject: "Your Expense Budget Tracker password reset code",
    headline: "Use this password reset code for Expense Budget Tracker:",
    expiry: englishOtpExpiry,
  },
  verification: {
    subject: "Your Expense Budget Tracker verification code",
    headline: "Use this verification code for Expense Budget Tracker:",
    expiry: englishOtpExpiry,
  },
  temporaryPassword: {
    subject: "Your Expense Budget Tracker temporary password",
    message: (password: string): string => `Your temporary password for Expense Budget Tracker is: ${password}`,
  },
  securityNotice: {
    subject: "Expense Budget Tracker security notice",
    message: "Expense Budget Tracker detected suspicious activity on your account. Review your recent sign-in attempts.",
  },
} as const;

type SignInEmailTranslations = Readonly<Partial<Record<Exclude<SupportedLocale, typeof DEFAULT_LOCALE>, OtpEmailCopy>>>;

const signInEmailTranslations: SignInEmailTranslations = {};

export const getLocalizedSignInEmailCopy = (locale: SupportedLocale | null): OtpEmailCopy | undefined =>
  locale === null || locale === DEFAULT_LOCALE ? undefined : signInEmailTranslations[locale];
