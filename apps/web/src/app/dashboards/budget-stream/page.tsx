import { Suspense } from "react";
import { headers } from "next/headers";

import { offsetMonth, getCurrentMonth } from "@/lib/monthUtils";
import { isDemoMode } from "@/lib/demoMode";
import { getBudgetGrid } from "@/server/budget/getBudgetGrid";
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
      />
    );
  }

  const headersList = await headers();
  const userId = headersList.get("x-user-id") ?? "local";
  const workspaceId = headersList.get("x-workspace-id") ?? "local";

  const { rows } = await getBudgetGrid(userId, workspaceId, monthFrom, monthTo, currentMonth, currentMonth);

  return (
    <BudgetStreamDashboard
      initialRows={rows}
      initialMonthFrom={monthFrom}
      initialMonthTo={monthTo}
    />
  );
}

export default function BudgetStreamPage() {
  return (
    <main className="container">
      <nav className="breadcrumbs">
        <a href="/">Home</a>
        <span className="breadcrumbs-sep">/</span>
        <span>Budget Stream</span>
      </nav>

      <section className="panel">
        <h1 className="title">Budget Stream</h1>

        <Suspense fallback={<LoadingIndicator />}>
          <BudgetStreamData />
        </Suspense>
      </section>
    </main>
  );
}
