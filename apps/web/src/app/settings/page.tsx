import { Suspense } from "react";
import { headers } from "next/headers";

import { isDemoMode } from "@/lib/demoMode";
import { DEFAULT_USER_SETTINGS } from "@/lib/locale";
import { getLocaleCookie } from "@/lib/localeCookie";
import { t } from "@/i18n/serverT";
import { listApiKeys } from "@/server/apiKeys";
import { getDemoCategories } from "@/server/demo/data";
import { getFilteredCategories } from "@/server/filteredCategories";
import { getAvailableCurrencies } from "@/server/getAvailableCurrencies";
import { getReportCurrency } from "@/server/reportCurrency";
import { extractUserIdFromHeaders, extractWorkspaceIdFromHeaders } from "@/server/userId";
import { getCategories } from "@/server/transactions/getTransactions";
import { getUserSettings } from "@/server/userSettings";
import { queryAs } from "@/server/db";
import { ApiKeyManager } from "@/ui/ApiKeyManager";
import { FilteredCategorySettings } from "@/ui/FilteredCategorySettings";
import { UserSettingsForm } from "@/ui/UserSettingsForm";
import { WorkspaceSettings } from "@/ui/WorkspaceSettings";
import { LoadingIndicator } from "@/ui/LoadingIndicator";

export const dynamic = "force-dynamic";

async function UserSettingsData() {
  const demo = await isDemoMode();

  if (demo) {
    const locale = await getLocaleCookie();
    return <UserSettingsForm locale={locale} numberFormat={DEFAULT_USER_SETTINGS.numberFormat} dateFormat={DEFAULT_USER_SETTINGS.dateFormat} />;
  }

  const headersList = await headers();
  const userId = extractUserIdFromHeaders(headersList);
  const workspaceId = extractWorkspaceIdFromHeaders(headersList);
  const initialLocale = await getLocaleCookie();
  const settings = await getUserSettings(userId, workspaceId, initialLocale);

  return <UserSettingsForm locale={settings.locale} numberFormat={settings.numberFormat} dateFormat={settings.dateFormat} />;
}

async function SettingsData() {
  const demo = await isDemoMode();

  if (demo) {
    return <WorkspaceSettings reportingCurrency="USD" availableCurrencies={["EUR", "GBP", "USD"]} firstDayOfWeek={1} timezone="UTC" />;
  }

  const headersList = await headers();
  const userId = extractUserIdFromHeaders(headersList);
  const workspaceId = extractWorkspaceIdFromHeaders(headersList);

  const [reportingCurrency, availableCurrencies] = await Promise.all([
    getReportCurrency(userId, workspaceId),
    getAvailableCurrencies(),
  ]);

  const currencies = availableCurrencies.includes(reportingCurrency)
    ? availableCurrencies
    : [...availableCurrencies, reportingCurrency].toSorted();

  let firstDayOfWeek = 1;
  let timezone = "UTC";
  try {
    const result = await queryAs(
      userId, workspaceId,
      "SELECT first_day_of_week, timezone FROM workspace_settings WHERE workspace_id = $1",
      [workspaceId],
    );
    if (result.rows.length > 0) {
      const row = result.rows[0] as { first_day_of_week: number; timezone: string };
      firstDayOfWeek = row.first_day_of_week;
      timezone = row.timezone;
    }
  } catch {
    // use defaults
  }

  return <WorkspaceSettings reportingCurrency={reportingCurrency} availableCurrencies={currencies} firstDayOfWeek={firstDayOfWeek} timezone={timezone} />;
}

async function FilteredCategoriesData() {
  const demo = await isDemoMode();

  if (demo) {
    return <FilteredCategorySettings filteredCategories={null} allCategories={getDemoCategories()} />;
  }

  const headersList = await headers();
  const userId = extractUserIdFromHeaders(headersList);
  const workspaceId = extractWorkspaceIdFromHeaders(headersList);

  const [filteredCategories, allCategories] = await Promise.all([
    getFilteredCategories(userId, workspaceId),
    getCategories(userId, workspaceId),
  ]);

  return <FilteredCategorySettings filteredCategories={filteredCategories} allCategories={allCategories} />;
}

async function ApiKeyData() {
  const demo = await isDemoMode();

  if (demo) {
    return null;
  }

  const headersList = await headers();
  const userId = extractUserIdFromHeaders(headersList);
  const workspaceId = extractWorkspaceIdFromHeaders(headersList);

  const initialKeys = await listApiKeys(userId, workspaceId);

  return <ApiKeyManager initialKeys={initialKeys} />;
}

export default async function SettingsPage() {
  const demo = await isDemoMode();
  let locale = DEFAULT_USER_SETTINGS.locale;
  if (demo) {
    locale = await getLocaleCookie();
  } else {
    try {
      const headersList = await headers();
      const userId = extractUserIdFromHeaders(headersList);
      const workspaceId = extractWorkspaceIdFromHeaders(headersList);
      const initialLocale = await getLocaleCookie();
      const settings = await getUserSettings(userId, workspaceId, initialLocale);
      locale = settings.locale;
    } catch {
      locale = await getLocaleCookie();
    }
  }

  return (
    <main className="container">
      <section className="panel">
        <h1 className="title">{t(locale, "settings.userSettings")}</h1>
        <Suspense fallback={<LoadingIndicator />}>
          <UserSettingsData />
        </Suspense>
      </section>

      <section className="panel">
        <h1 className="title">{t(locale, "settings.workspaceSettings")}</h1>
        <Suspense fallback={<LoadingIndicator />}>
          <SettingsData />
        </Suspense>
      </section>

      <section className="panel">
        <h1 className="title">{t(locale, "settings.filteredCategories")}</h1>
        <Suspense fallback={<LoadingIndicator />}>
          <FilteredCategoriesData />
        </Suspense>
      </section>

      <section className="panel">
        <h1 className="title">{t(locale, "settings.apiKeys")}</h1>
        <Suspense fallback={<LoadingIndicator />}>
          <ApiKeyData />
        </Suspense>
      </section>
    </main>
  );
}
