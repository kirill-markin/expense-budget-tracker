import { Suspense } from "react";
import { headers } from "next/headers";

import { isDemoMode } from "@/lib/demoMode";
import { DEFAULT_USER_SETTINGS } from "@/lib/locale";
import { getLocaleCookie } from "@/lib/localeCookie";
import { t } from "@/i18n/serverT";
import { getBalancesSummary } from "@/server/balances/getBalancesSummary";
import { getReportCurrency } from "@/server/reportCurrency";
import { extractUserIdFromHeaders, extractWorkspaceIdFromHeaders } from "@/server/userId";
import { getUserSettings } from "@/server/userSettings";
import { getDemoBalancesSummary } from "@/server/demo/data";
import { BalancesTable } from "@/ui/tables/balances/BalancesTable";
import { LoadingIndicator } from "@/ui/LoadingIndicator";

export const dynamic = "force-dynamic";

async function BalancesData() {
  const demo = await isDemoMode();
  // A route refresh regenerates this token so the client table can confirm the
  // latest no-store balance summary without relying only on the RSC payload.
  const refreshToken = crypto.randomUUID();

  if (demo) {
    const { accounts, totals, conversionWarnings } = getDemoBalancesSummary();
    return <BalancesTable accounts={accounts} totals={totals} conversionWarnings={conversionWarnings} reportingCurrency="USD" refreshToken={refreshToken} />;
  }

  const headersList = await headers();
  const userId = extractUserIdFromHeaders(headersList);
  const workspaceId = extractWorkspaceIdFromHeaders(headersList);
  const [{ accounts, totals, conversionWarnings }, reportingCurrency] = await Promise.all([
    getBalancesSummary(userId, workspaceId),
    getReportCurrency(userId, workspaceId),
  ]);

  return <BalancesTable accounts={accounts} totals={totals} conversionWarnings={conversionWarnings} reportingCurrency={reportingCurrency} refreshToken={refreshToken} />;
}

export default async function BalancesDashboardPage() {
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
        <h1 className="title">{t(locale, "nav.balances")}</h1>

        <Suspense fallback={<LoadingIndicator />}>
          <BalancesData />
        </Suspense>
      </section>
    </main>
  );
}
