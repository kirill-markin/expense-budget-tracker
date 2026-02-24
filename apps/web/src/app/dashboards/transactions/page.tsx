import { Suspense } from "react";
import { headers } from "next/headers";

import { isDemoMode } from "@/lib/demoMode";
import { getAccounts } from "@/server/transactions/getTransactions";
import { getDemoAccounts } from "@/server/demo/data";
import { TransactionsRawTable } from "@/ui/tables/TransactionsRawTable";
import { LoadingIndicator } from "@/ui/LoadingIndicator";

export const dynamic = "force-dynamic";

async function TransactionsData() {
  const demo = await isDemoMode();

  if (demo) {
    const accounts = getDemoAccounts();
    return <TransactionsRawTable accounts={accounts} />;
  }

  const headersList = await headers();
  const userId = headersList.get("x-user-id") ?? "local";
  const workspaceId = headersList.get("x-workspace-id") ?? "local";
  const accounts = await getAccounts(userId, workspaceId);

  return <TransactionsRawTable accounts={accounts} />;
}

export default function TransactionsDashboardPage() {
  return (
    <main className="container">
      <section className="panel">
        <h1 className="title">Transactions</h1>

        <Suspense fallback={<LoadingIndicator />}>
          <TransactionsData />
        </Suspense>
      </section>
    </main>
  );
}
