import { Suspense } from "react";
import { headers } from "next/headers";

import { isDemoMode } from "@/lib/demoMode";
import { DEFAULT_USER_SETTINGS } from "@/lib/locale";
import { getLocaleCookie } from "@/lib/localeCookie";
import { t } from "@/i18n/serverT";
import { getBalancesSummary } from "@/server/balances/getBalancesSummary";
import { getReportCurrency } from "@/server/reportCurrency";
import { getUserSettings } from "@/server/userSettings";
import { getDemoBalancesSummary } from "@/server/demo/data";
import { BalancesTable } from "@/ui/tables/BalancesTable";
import { LoadingIndicator } from "@/ui/LoadingIndicator";

export const dynamic = "force-dynamic";

async function BalancesData() {
  const demo = await isDemoMode();

  if (demo) {
    const { accounts, totals, conversionWarnings } = getDemoBalancesSummary();
    return <BalancesTable accounts={accounts} totals={totals} conversionWarnings={conversionWarnings} reportingCurrency="USD" />;
  }

  const headersList = await headers();
  const userId = headersList.get("x-user-id") ?? "local";
  const workspaceId = headersList.get("x-workspace-id") ?? "local";
  const [{ accounts, totals, conversionWarnings }, reportingCurrency] = await Promise.all([
    getBalancesSummary(userId, workspaceId),
    getReportCurrency(userId, workspaceId),
  ]);

  return <BalancesTable accounts={accounts} totals={totals} conversionWarnings={conversionWarnings} reportingCurrency={reportingCurrency} />;
}

export default async function BalancesDashboardPage() {
  const demo = await isDemoMode();
  let locale = DEFAULT_USER_SETTINGS.locale;
  if (demo) {
    locale = await getLocaleCookie();
  } else {
    try {
      const headersList = await headers();
      const userId = headersList.get("x-user-id") ?? "local";
      const workspaceId = headersList.get("x-workspace-id") ?? "local";
      const settings = await getUserSettings(userId, workspaceId);
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
