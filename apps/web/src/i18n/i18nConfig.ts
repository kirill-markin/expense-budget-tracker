import i18next, { type i18n } from "i18next";

import type { SupportedLocale } from "@/lib/locale";

export type TranslationBundle = Readonly<Record<string, string>>;

export const initI18n = (locale: SupportedLocale, messages: TranslationBundle): i18n => {
  const instance = i18next.createInstance();
  void instance.init({
    lng: locale,
    load: "currentOnly",
    fallbackLng: false,
    initAsync: false,
    interpolation: { escapeValue: false },
    resources: { [locale]: { translation: { ...messages } } },
  });

  return instance;
};
