import { Suspense } from "react";
import { headers } from "next/headers";

import { isDemoMode } from "@/lib/demoMode";
import { getAccounts, getCategories } from "@/server/transactions/getTransactions";
import { getDemoAccounts, getDemoCategories } from "@/server/demo/data";
import { TransactionsRawTable } from "@/ui/tables/TransactionsRawTable";
import { LoadingIndicator } from "@/ui/LoadingIndicator";

export const dynamic = "force-dynamic";

async function TransactionsData() {
  const demo = await isDemoMode();

  if (demo) {
    const accounts = getDemoAccounts();
    const categories = getDemoCategories();
    return <TransactionsRawTable accounts={accounts} categories={categories} />;
  }

  const headersList = await headers();
  const userId = headersList.get("x-user-id") ?? "local";
  const workspaceId = headersList.get("x-workspace-id") ?? "local";
  const [accounts, categories] = await Promise.all([
    getAccounts(userId, workspaceId),
    getCategories(userId, workspaceId),
  ]);

  return <TransactionsRawTable accounts={accounts} categories={categories} />;
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
