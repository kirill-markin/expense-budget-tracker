import { Suspense } from "react";
import { cookies, headers } from "next/headers";

import { DEMO_BUDGET_ADJUSTMENTS_COOKIE } from "@/lib/demoCookies";
import { offsetMonth, getCurrentMonth } from "@/lib/monthUtils";
import { isDemoMode } from "@/lib/demoMode";
import { DEFAULT_USER_SETTINGS } from "@/lib/locale";
import { getLocaleCookie } from "@/lib/localeCookie";
import { t } from "@/i18n/serverT";
import { getBudgetGrid } from "@/server/budget/getBudgetGrid";
import { getReportCurrency } from "@/server/reportCurrency";
import { extractUserIdFromHeaders, extractWorkspaceIdFromHeaders } from "@/server/userId";
import { getFieldHints } from "@/server/transactions/getTransactions";
import { getUserSettings } from "@/server/userSettings";
import { getDemoBudgetAdjustmentsForSession, parseDemoBudgetAdjustmentSessionCookie } from "@/server/demo/budgetAdjustments";
import { getDemoBudgetGrid, getDemoFieldHints } from "@/server/demo/data";
import { BudgetTable } from "@/ui/tables/budget/BudgetTable";
import { LoadingIndicator } from "@/ui/LoadingIndicator";

export const dynamic = "force-dynamic";

const INITIAL_PAST_MONTHS = 6;
const INITIAL_FUTURE_MONTHS = 12;

async function BudgetData() {
  const demo = await isDemoMode();
  // A route refresh regenerates this token so the grid and its client-side
  // overlays can refetch live data against the same refreshed snapshot.
  const refreshToken = crypto.randomUUID();
  const currentMonth = getCurrentMonth();
  const monthFrom = offsetMonth(currentMonth, -INITIAL_PAST_MONTHS);
  const monthTo = offsetMonth(currentMonth, INITIAL_FUTURE_MONTHS);

  if (demo) {
    const cookieStore = await cookies();
    const adjustments = getDemoBudgetAdjustmentsForSession(
      parseDemoBudgetAdjustmentSessionCookie(
        cookieStore.get(DEMO_BUDGET_ADJUSTMENTS_COOKIE)?.value ?? null,
      ),
    );
    const {
      rows,
      adjustments: initialAdjustments,
      conversionWarnings,
      cumulativeBefore,
      monthEndBalances,
      monthEndBalancesByLiquidity,
      businessPersonalTransfers,
      hasBusinessAccount,
    } = getDemoBudgetGrid(
      monthFrom,
      monthTo,
      currentMonth,
      currentMonth,
      adjustments,
    );
    const hints = getDemoFieldHints();
    return (
      <BudgetTable
        rows={rows}
        adjustments={initialAdjustments}
        conversionWarnings={conversionWarnings}
        cumulativeBefore={cumulativeBefore}
        monthEndBalances={monthEndBalances}
        monthEndBalancesByLiquidity={monthEndBalancesByLiquidity}
        businessPersonalTransfers={businessPersonalTransfers}
        hasBusinessAccount={hasBusinessAccount}
        initialMonthFrom={monthFrom}
        initialMonthTo={monthTo}
        reportingCurrency="USD"
        hints={hints}
        refreshToken={refreshToken}
      />
    );
  }

  const headersList = await headers();
  const userId = extractUserIdFromHeaders(headersList);
  const workspaceId = extractWorkspaceIdFromHeaders(headersList);

  const [{
    rows,
    adjustments,
    conversionWarnings,
    cumulativeBefore,
    monthEndBalances,
    monthEndBalancesByLiquidity,
    businessPersonalTransfers,
    hasBusinessAccount,
  }, reportingCurrency, hints] = await Promise.all([
    getBudgetGrid(userId, workspaceId, monthFrom, monthTo, currentMonth, currentMonth),
    getReportCurrency(userId, workspaceId),
    getFieldHints(userId, workspaceId),
  ]);

  return (
    <BudgetTable
      rows={rows}
      adjustments={adjustments}
      conversionWarnings={conversionWarnings}
      cumulativeBefore={cumulativeBefore}
      monthEndBalances={monthEndBalances}
      monthEndBalancesByLiquidity={monthEndBalancesByLiquidity}
      businessPersonalTransfers={businessPersonalTransfers}
      hasBusinessAccount={hasBusinessAccount}
      initialMonthFrom={monthFrom}
      initialMonthTo={monthTo}
      reportingCurrency={reportingCurrency}
      hints={hints}
      refreshToken={refreshToken}
    />
  );
}

export default async function BudgetDashboardPage() {
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
        <h1 className="title">{t(locale, "nav.budget")}</h1>

        <Suspense fallback={<LoadingIndicator />}>
          <BudgetData />
        </Suspense>
      </section>
    </main>
  );
}
