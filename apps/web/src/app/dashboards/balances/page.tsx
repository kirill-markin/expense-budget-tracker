import { Suspense } from "react";
import { headers } from "next/headers";

import { getBalancesSummary } from "@/server/balances/getBalancesSummary";
import { BalancesTable } from "@/ui/tables/BalancesTable";
import { LoadingIndicator } from "@/ui/LoadingIndicator";

export const dynamic = "force-dynamic";

async function BalancesData() {
  const headersList = await headers();
  const userId = headersList.get("x-user-id") ?? "local";
  const workspaceId = headersList.get("x-workspace-id") ?? "local";
  const { accounts, totals, conversionWarnings } = await getBalancesSummary(userId, workspaceId);

  return <BalancesTable accounts={accounts} totals={totals} conversionWarnings={conversionWarnings} />;
}

export default function BalancesDashboardPage() {
  return (
    <main className="container">
      <nav className="breadcrumbs">
        <a href="/">Home</a>
        <span className="breadcrumbs-sep">/</span>
        <span>Balances</span>
      </nav>

      <section className="panel">
        <h1 className="title">Balances</h1>

        <Suspense fallback={<LoadingIndicator />}>
          <BalancesData />
        </Suspense>
      </section>
    </main>
  );
}
