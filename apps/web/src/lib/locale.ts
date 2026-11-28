import {
  DEFAULT_LOCALE,
  LOCALE_REGISTRY,
  SUPPORTED_LOCALES,
  parseSupportedLocale,
  type SupportedLocale,
} from "@expense-budget-tracker/agent-shared/locales";

import type { ThemePreference } from "@/lib/theme";

export { DEFAULT_LOCALE, LOCALE_REGISTRY, SUPPORTED_LOCALES, parseSupportedLocale };
export type { SupportedLocale };

export const RTL_LOCALES: ReadonlySet<SupportedLocale> = new Set(
  SUPPORTED_LOCALES.filter((locale) => LOCALE_REGISTRY[locale].direction === "rtl"),
);

export type NumberFormat = "1,234.56" | "1 234,56" | "1.234,56" | "1 234.56";

export const NUMBER_FORMATS: ReadonlyArray<NumberFormat> = ["1,234.56", "1 234,56", "1.234,56", "1 234.56"];

export type DateFormat = "DD.MM.YYYY" | "MM/DD/YYYY" | "YYYY-MM-DD";

export const DATE_FORMATS: ReadonlyArray<DateFormat> = ["DD.MM.YYYY", "MM/DD/YYYY", "YYYY-MM-DD"];

export type EnabledAutoFilterDelayMinutes = 1 | 2 | 5 | 10 | 30;

export type AutoFilterDelayMinutes = EnabledAutoFilterDelayMinutes | null;

export const AUTO_FILTER_DELAY_MINUTES: ReadonlyArray<EnabledAutoFilterDelayMinutes> = [1, 2, 5, 10, 30];

export type UserSettings = Readonly<{
  locale: SupportedLocale;
  numberFormat: NumberFormat;
  dateFormat: DateFormat;
  autoFilterDelayMinutes: AutoFilterDelayMinutes;
  theme: ThemePreference;
  lowercase: boolean;
}>;

export const DEFAULT_USER_SETTINGS: UserSettings = {
  locale: DEFAULT_LOCALE,
  numberFormat: "1,234.56",
  dateFormat: "YYYY-MM-DD",
  autoFilterDelayMinutes: 2,
  theme: "system",
  lowercase: false,
};

export const resolveLocale = (raw: string): SupportedLocale => {
  const locale = parseSupportedLocale(raw);
  if (locale !== null) return locale;
  console.warn("Unknown locale '%s', falling back to '%s'", raw, DEFAULT_LOCALE);
  return DEFAULT_LOCALE;
};
