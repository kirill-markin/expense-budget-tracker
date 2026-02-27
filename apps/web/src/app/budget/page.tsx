import { Suspense } from "react";
import { headers } from "next/headers";

import { offsetMonth, getCurrentMonth } from "@/lib/monthUtils";
import { isDemoMode } from "@/lib/demoMode";
import { getBudgetGrid } from "@/server/budget/getBudgetGrid";
import { getReportCurrency } from "@/server/reportCurrency";
import { getFieldHints } from "@/server/transactions/getTransactions";
import { getDemoBudgetGrid, getDemoFieldHints } from "@/server/demo/data";
import { BudgetTable } from "@/ui/tables/BudgetTable";
import { LoadingIndicator } from "@/ui/LoadingIndicator";

export const dynamic = "force-dynamic";

const INITIAL_PAST_MONTHS = 6;
const INITIAL_FUTURE_MONTHS = 12;

async function BudgetData() {
  const demo = await isDemoMode();
  const currentMonth = getCurrentMonth();
  const monthFrom = offsetMonth(currentMonth, -INITIAL_PAST_MONTHS);
  const monthTo = offsetMonth(currentMonth, INITIAL_FUTURE_MONTHS);

  if (demo) {
    const { rows, conversionWarnings, cumulativeBefore, monthEndBalances, monthEndBalancesByLiquidity } = getDemoBudgetGrid(monthFrom, monthTo, currentMonth, currentMonth);
    const hints = getDemoFieldHints();
    return (
      <BudgetTable
        rows={rows}
        conversionWarnings={conversionWarnings}
        cumulativeBefore={cumulativeBefore}
        monthEndBalances={monthEndBalances}
        monthEndBalancesByLiquidity={monthEndBalancesByLiquidity}
        initialMonthFrom={monthFrom}
        initialMonthTo={monthTo}
        reportingCurrency="USD"
        hints={hints}
      />
    );
  }

  const headersList = await headers();
  const userId = headersList.get("x-user-id") ?? "local";
  const workspaceId = headersList.get("x-workspace-id") ?? "local";

  const [{ rows, conversionWarnings, cumulativeBefore, monthEndBalances, monthEndBalancesByLiquidity }, reportingCurrency, hints] = await Promise.all([
    getBudgetGrid(userId, workspaceId, monthFrom, monthTo, currentMonth, currentMonth),
    getReportCurrency(userId, workspaceId),
    getFieldHints(userId, workspaceId),
  ]);

  return (
    <BudgetTable
      rows={rows}
      conversionWarnings={conversionWarnings}
      cumulativeBefore={cumulativeBefore}
      monthEndBalances={monthEndBalances}
      monthEndBalancesByLiquidity={monthEndBalancesByLiquidity}
      initialMonthFrom={monthFrom}
      initialMonthTo={monthTo}
      reportingCurrency={reportingCurrency}
      hints={hints}
    />
  );
}

export default function BudgetDashboardPage() {
  return (
    <main className="container">
      <section className="panel">
        <h1 className="title">Budget</h1>

        <Suspense fallback={<LoadingIndicator />}>
          <BudgetData />
        </Suspense>
      </section>
    </main>
  );
}
