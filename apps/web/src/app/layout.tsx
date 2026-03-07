import type { Metadata } from "next";
import { headers } from "next/headers";

import { readChatCookies } from "@/lib/chatCookies";
import { isDemoMode } from "@/lib/demoMode";
import { DEFAULT_USER_SETTINGS, RTL_LOCALES, type SupportedLocale } from "@/lib/locale";
import { getLocaleCookie } from "@/lib/localeCookie";
import { NAV_LINKS } from "@/lib/navigation";
import { I18nProvider } from "@/i18n/I18nProvider";
import { t } from "@/i18n/serverT";
import { listWorkspaces, type WorkspaceSummary } from "@/server/listWorkspaces";
import { getReportCurrency } from "@/server/reportCurrency";
import { getUserSettings } from "@/server/userSettings";
import { extractUserIdFromHeaders, extractWorkspaceIdFromHeaders } from "@/server/userId";
import { AccountMenu } from "@/ui/AccountMenu";
import { ChatLayoutProvider } from "@/ui/chat/ChatLayoutProvider";
import { ChatLayoutShell } from "@/ui/chat/ChatLayoutShell";
import { CurrencySelector } from "@/ui/CurrencySelector";
import { FilteredBanner } from "@/ui/FilteredBanner";
import { FilteredModeProvider } from "@/ui/FilteredModeProvider";
import { FormatProvider } from "@/ui/FormatProvider";
import { ModeToggle } from "@/ui/ModeToggle";

import "./globals.css";

export const metadata: Metadata = {
  title: "Expense Budget Tracker",
  description: "Personal finance tracker",
};

export default async function RootLayout(props: Readonly<{ children: React.ReactNode }>) {
  const { children } = props;
  const demo = await isDemoMode();
  const { chatOpen, chatWidth } = await readChatCookies();

  const authEnabled = process.env.AUTH_MODE === "cognito";
  let reportingCurrency = "USD";
  let workspaces: ReadonlyArray<WorkspaceSummary> = [];
  let currentWorkspaceId = "";
  let locale: SupportedLocale = "en";
  let numberFormat = DEFAULT_USER_SETTINGS.numberFormat;
  let dateFormat = DEFAULT_USER_SETTINGS.dateFormat;

  if (demo) {
    locale = await getLocaleCookie();
  } else {
    try {
      const headersList = await headers();
      const userId = extractUserIdFromHeaders(headersList);
      let workspaceId = extractWorkspaceIdFromHeaders(headersList);
      try {
        reportingCurrency = await getReportCurrency(userId, workspaceId);
      } catch {
        workspaceId = userId;
        reportingCurrency = await getReportCurrency(userId, workspaceId);
      }
      currentWorkspaceId = workspaceId;
      if (authEnabled) {
        workspaces = await listWorkspaces(userId, workspaceId);
      }
      const initialLocale = await getLocaleCookie();
      const userSettings = await getUserSettings(userId, workspaceId, initialLocale);
      locale = userSettings.locale;
      numberFormat = userSettings.numberFormat;
      dateFormat = userSettings.dateFormat;
    } catch (err) {
      console.error("Layout DB unavailable, using defaults: %s", err instanceof Error ? err.message : String(err));
      locale = await getLocaleCookie();
    }
  }

  return (
    <html lang={locale} dir={RTL_LOCALES.has(locale) ? "rtl" : "ltr"}>
      <body>
        <I18nProvider locale={locale}>
          <FormatProvider numberFormat={numberFormat} dateFormat={dateFormat}>
            <FilteredModeProvider isDemoMode={demo}>
              <div className="header-sticky">
                {demo && (
                  <div className="demo-banner">
                    {t(locale, "demo.banner")}<span className="demo-banner-detail"> {t(locale, "demo.bannerDetail")}</span>
                  </div>
                )}
                <FilteredBanner />
                <header className="topbar">
                  <a href="/" className="topbar-brand">
                    <span className="brand-full">{t(locale, "brand.full")}</span>
                    <span className="brand-short">{t(locale, "brand.short")}</span>
                  </a>
                  <div className="topbar-actions">
                    <ModeToggle isDemoMode={demo} />
                    <AccountMenu
                      authEnabled={authEnabled}
                      workspaces={workspaces}
                      currentWorkspaceId={currentWorkspaceId}
                    />
                  </div>
                </header>
                <nav className="nav">
                  {NAV_LINKS.map((link) => (
                    <a key={link.href} href={link.href}>{t(locale, link.labelKey)}</a>
                  ))}
                  <CurrencySelector initialCurrency={reportingCurrency} titleText={t(locale, "currency.title")} />
                </nav>
              </div>
              <ChatLayoutProvider initialChatOpen={chatOpen} initialChatWidth={chatWidth}>
                <ChatLayoutShell>
                  {children}
                </ChatLayoutShell>
              </ChatLayoutProvider>
            </FilteredModeProvider>
          </FormatProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
