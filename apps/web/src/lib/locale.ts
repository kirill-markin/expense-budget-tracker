export type SupportedLocale = "en" | "ru" | "es" | "uk" | "fa" | "zh" | "ar" | "he";

export const SUPPORTED_LOCALES: ReadonlyArray<SupportedLocale> = ["en", "ru", "es", "uk", "fa", "zh", "ar", "he"];

export const LOCALE_LABELS: Readonly<Record<SupportedLocale, string>> = {
  en: "English",
  ru: "Русский",
  es: "Español",
  uk: "Українська",
  fa: "فارسی",
  zh: "中文",
  ar: "العربية",
  he: "עברית",
};

export const RTL_LOCALES: ReadonlySet<SupportedLocale> = new Set(["fa", "ar", "he"]);

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
}>;

export const DEFAULT_USER_SETTINGS: UserSettings = {
  locale: "en",
  numberFormat: "1,234.56",
  dateFormat: "YYYY-MM-DD",
  autoFilterDelayMinutes: 2,
};

export const resolveLocale = (raw: string): SupportedLocale => {
  if ((SUPPORTED_LOCALES as ReadonlyArray<string>).includes(raw)) {
    return raw as SupportedLocale;
  }
  console.warn("Unknown locale '%s', falling back to 'en'", raw);
  return "en";
};
