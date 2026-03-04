import type { SupportedLocale } from "@/lib/locale";

import ar from "./ar.json";
import en from "./en.json";
import es from "./es.json";
import fa from "./fa.json";
import he from "./he.json";
import ru from "./ru.json";
import uk from "./uk.json";
import zh from "./zh.json";

type TranslationBundle = Readonly<Record<string, string>>;

const bundles: Readonly<Record<SupportedLocale, TranslationBundle>> = {
  en: en as TranslationBundle,
  ru: ru as TranslationBundle,
  es: es as TranslationBundle,
  uk: uk as TranslationBundle,
  fa: fa as TranslationBundle,
  zh: zh as TranslationBundle,
  ar: ar as TranslationBundle,
  he: he as TranslationBundle,
};

/** Direct key lookup for server components. Falls back to English on missing key. */
export const t = (locale: SupportedLocale, key: string): string => {
  const value = bundles[locale][key];
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
