import i18next, { type i18n } from "i18next";
import { initReactI18next } from "react-i18next";

import type { SupportedLocale } from "@/lib/locale";

import ar from "./ar.json";
import en from "./en.json";
import es from "./es.json";
import fa from "./fa.json";
import ru from "./ru.json";
import uk from "./uk.json";
import zh from "./zh.json";

const instances = new Map<SupportedLocale, i18n>();

export const initI18n = (locale: SupportedLocale): i18n => {
  const cached = instances.get(locale);
  if (cached !== undefined) return cached;

  const instance = i18next.createInstance();
  instance.use(initReactI18next).init({
    lng: locale,
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    resources: {
      en: { translation: en },
      ru: { translation: ru },
      es: { translation: es },
      uk: { translation: uk },
      fa: { translation: fa },
      zh: { translation: zh },
      ar: { translation: ar },
    },
  });

  instances.set(locale, instance);
  return instance;
};
