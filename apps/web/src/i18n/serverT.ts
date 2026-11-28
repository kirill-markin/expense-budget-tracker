import type { SupportedLocale } from "@/lib/locale";

import type { TranslationBundle } from "./i18nConfig";

import ar from "./ar.json";
import en from "./en.json";
import es from "./es.json";
import fa from "./fa.json";
import he from "./he.json";
import ru from "./ru.json";
import uk from "./uk.json";
import zh from "./zh.json";

const bundles: Readonly<Record<SupportedLocale, TranslationBundle>> = {
  en,
  ru,
  es,
  uk,
  fa,
  zh,
  ar,
  he,
};

export const getMessages = (locale: SupportedLocale): TranslationBundle => bundles[locale];

/** Direct key lookup for server components. Falls back to English on missing key. */
export const t = (locale: SupportedLocale, key: string): string => {
  const value = getMessages(locale)[key];
  if (value !== undefined) return value;
  const fallback = bundles.en[key];
  if (fallback !== undefined) {
    console.warn("Missing translation for key '%s' in locale '%s'", key, locale);
    return fallback;
  }
  console.warn("Missing translation key '%s'", key);
  return key;
};

/** Key lookup with {{var}} interpolation for server components. */
export const ti = (locale: SupportedLocale, key: string, params: Readonly<Record<string, string | number>>): string => {
  let value = t(locale, key);
  for (const [paramKey, paramValue] of Object.entries(params)) {
    value = value.replaceAll(`{{${paramKey}}}`, String(paramValue));
  }
  return value;
};
