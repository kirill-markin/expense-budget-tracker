"use client";

import type { ReactElement, ReactNode } from "react";
import { I18nextProvider } from "react-i18next";

import type { SupportedLocale } from "@/lib/locale";

import { initI18n } from "./i18nConfig";

type Props = Readonly<{
  locale: SupportedLocale;
  children: ReactNode;
}>;

export const I18nProvider = (props: Props): ReactElement => {
  const { locale, children } = props;
  const i18n = initI18n(locale);

  return (
    <I18nextProvider i18n={i18n}>
      {children}
    </I18nextProvider>
  );
};
