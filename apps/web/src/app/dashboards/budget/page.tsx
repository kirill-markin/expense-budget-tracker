import { Suspense } from "react";
import { headers } from "next/headers";

import { offsetMonth, getCurrentMonth } from "@/lib/monthUtils";
import { isDemoMode } from "@/lib/demoMode";
import { getBudgetGrid } from "@/server/budget/getBudgetGrid";
import { getDemoBudgetGrid } from "@/server/demo/data";
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
    const { rows, conversionWarnings, cumulativeBefore, monthEndBalances } = getDemoBudgetGrid(monthFrom, monthTo, currentMonth, currentMonth);
    return (
      <BudgetTable
        rows={rows}
        conversionWarnings={conversionWarnings}
        cumulativeBefore={cumulativeBefore}
        monthEndBalances={monthEndBalances}
        initialMonthFrom={monthFrom}
        initialMonthTo={monthTo}
      />
    );
  }

  const headersList = await headers();
  const userId = headersList.get("x-user-id") ?? "local";
  const workspaceId = headersList.get("x-workspace-id") ?? "local";

  const { rows, conversionWarnings, cumulativeBefore, monthEndBalances } = await getBudgetGrid(userId, workspaceId, monthFrom, monthTo, currentMonth, currentMonth);

  return (
    <BudgetTable
      rows={rows}
      conversionWarnings={conversionWarnings}
      cumulativeBefore={cumulativeBefore}
      monthEndBalances={monthEndBalances}
      initialMonthFrom={monthFrom}
      initialMonthTo={monthTo}
    />
  );
}

export default function BudgetDashboardPage() {
  return (
    <main className="container">
      <nav className="breadcrumbs">
        <a href="/">Home</a>
        <span className="breadcrumbs-sep">/</span>
        <span>Budget</span>
      </nav>

      <section className="panel">
        <h1 className="title">Budget</h1>

        <Suspense fallback={<LoadingIndicator />}>
          <BudgetData />
        </Suspense>
      </section>
    </main>
  );
}
