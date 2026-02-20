import { Suspense } from "react";

import { offsetMonth, getCurrentMonth } from "@/lib/monthUtils";
import { getBudgetGrid } from "@/server/budget/getBudgetGrid";
import { BudgetStreamDashboard } from "@/ui/charts/BudgetStreamDashboard";
import { LoadingIndicator } from "@/ui/LoadingIndicator";

export const dynamic = "force-dynamic";

const INITIAL_PAST_MONTHS = 12;

async function BudgetStreamData() {
  const currentMonth = getCurrentMonth();
  const monthFrom = offsetMonth(currentMonth, -INITIAL_PAST_MONTHS);
  const monthTo = currentMonth;

  const { rows } = await getBudgetGrid(monthFrom, monthTo, currentMonth, currentMonth);

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
