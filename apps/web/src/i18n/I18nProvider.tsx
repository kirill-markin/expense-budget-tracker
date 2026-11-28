"use client";

import { useMemo, type ReactElement, type ReactNode } from "react";
import { I18nextProvider } from "react-i18next";

import type { SupportedLocale } from "@/lib/locale";

import { initI18n, type TranslationBundle } from "./i18nConfig";

type Props = Readonly<{
  locale: SupportedLocale;
  messages: TranslationBundle;
  children: ReactNode;
}>;

export const I18nProvider = (props: Props): ReactElement => {
  const { locale, messages, children } = props;
  const i18n = useMemo(() => initI18n(locale, messages), [locale, messages]);

  return (
    <I18nextProvider i18n={i18n}>
      {children}
    </I18nextProvider>
  );
};
