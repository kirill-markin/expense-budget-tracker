import { Suspense } from "react";
import { headers } from "next/headers";

import { offsetMonth, getCurrentMonth } from "@/lib/monthUtils";
import { isDemoMode } from "@/lib/demoMode";
import { DEFAULT_USER_SETTINGS } from "@/lib/locale";
import { getLocaleCookie } from "@/lib/localeCookie";
import { t } from "@/i18n/serverT";
import { getBudgetGrid } from "@/server/budget/getBudgetGrid";
import { getReportCurrency } from "@/server/reportCurrency";
import { extractUserIdFromHeaders, extractWorkspaceIdFromHeaders } from "@/server/userId";
import { getUserSettings } from "@/server/userSettings";
import { getDemoBudgetGrid } from "@/server/demo/data";
import { BudgetStreamDashboard } from "@/ui/charts/BudgetStreamDashboard";
import { LoadingIndicator } from "@/ui/LoadingIndicator";

export const dynamic = "force-dynamic";

const INITIAL_PAST_MONTHS = 12;

async function BudgetStreamData() {
  const demo = await isDemoMode();
  const currentMonth = getCurrentMonth();
  const monthFrom = offsetMonth(currentMonth, -INITIAL_PAST_MONTHS);
  const monthTo = currentMonth;

  if (demo) {
    const { rows } = getDemoBudgetGrid(monthFrom, monthTo, currentMonth, currentMonth);
    return (
      <BudgetStreamDashboard
        initialRows={rows}
        initialMonthFrom={monthFrom}
        initialMonthTo={monthTo}
        reportingCurrency="USD"
      />
    );
  }

  const headersList = await headers();
  const userId = extractUserIdFromHeaders(headersList);
  const workspaceId = extractWorkspaceIdFromHeaders(headersList);

  const [{ rows }, reportingCurrency] = await Promise.all([
    getBudgetGrid(userId, workspaceId, monthFrom, monthTo, currentMonth, currentMonth),
    getReportCurrency(userId, workspaceId),
  ]);

  return (
    <BudgetStreamDashboard
      initialRows={rows}
      initialMonthFrom={monthFrom}
      initialMonthTo={monthTo}
      reportingCurrency={reportingCurrency}
    />
  );
}

export default async function DashboardPage() {
  const demo = await isDemoMode();
  let locale = DEFAULT_USER_SETTINGS.locale;
  if (demo) {
    locale = await getLocaleCookie();
  } else {
    try {
      const headersList = await headers();
      const userId = extractUserIdFromHeaders(headersList);
      const workspaceId = extractWorkspaceIdFromHeaders(headersList);
      const settings = await getUserSettings(userId, workspaceId);
      locale = settings.locale;
    } catch {
      locale = await getLocaleCookie();
    }
  }

  return (
    <main className="container">
      <section className="panel">
        <h1 className="title">{t(locale, "nav.dashboards")}</h1>

        <Suspense fallback={<LoadingIndicator />}>
          <BudgetStreamData />
        </Suspense>
      </section>
    </main>
  );
}
