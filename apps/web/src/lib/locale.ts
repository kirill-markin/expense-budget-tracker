export type SupportedLocale = "en" | "ru" | "es" | "uk" | "fa" | "zh" | "ar";

export const SUPPORTED_LOCALES: ReadonlyArray<SupportedLocale> = ["en", "ru", "es", "uk", "fa", "zh", "ar"];

export const LOCALE_LABELS: Readonly<Record<SupportedLocale, string>> = {
  en: "English",
  ru: "Русский",
  es: "Español",
  uk: "Українська",
  fa: "فارسی",
  zh: "中文",
  ar: "العربية",
};

export const RTL_LOCALES: ReadonlySet<SupportedLocale> = new Set(["fa", "ar"]);

export type NumberFormat = "1,234.56" | "1 234,56" | "1.234,56";

export const NUMBER_FORMATS: ReadonlyArray<NumberFormat> = ["1,234.56", "1 234,56", "1.234,56"];

export type DateFormat = "DD.MM.YYYY" | "MM/DD/YYYY" | "YYYY-MM-DD";

export const DATE_FORMATS: ReadonlyArray<DateFormat> = ["DD.MM.YYYY", "MM/DD/YYYY", "YYYY-MM-DD"];

export type UserSettings = Readonly<{
  locale: SupportedLocale;
  numberFormat: NumberFormat;
  dateFormat: DateFormat;
}>;

export const DEFAULT_USER_SETTINGS: UserSettings = {
  locale: "en",
  numberFormat: "1,234.56",
  dateFormat: "YYYY-MM-DD",
};

export const resolveLocale = (raw: string): SupportedLocale => {
  if ((SUPPORTED_LOCALES as ReadonlyArray<string>).includes(raw)) {
    return raw as SupportedLocale;
  }
  console.warn("Unknown locale '%s', falling back to 'en'", raw);
  return "en";
};
