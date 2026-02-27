import { Suspense } from "react";
import { headers } from "next/headers";

import { isDemoMode } from "@/lib/demoMode";
import { getAccounts, getCategories, getFieldHints } from "@/server/transactions/getTransactions";
import { getDemoAccounts, getDemoCategories, getDemoFieldHints } from "@/server/demo/data";
import { TransactionsRawTable } from "@/ui/tables/TransactionsRawTable";
import { LoadingIndicator } from "@/ui/LoadingIndicator";

export const dynamic = "force-dynamic";

async function TransactionsData() {
  const demo = await isDemoMode();

  if (demo) {
    const accounts = getDemoAccounts();
    const categories = getDemoCategories();
    const hints = getDemoFieldHints();
    return <TransactionsRawTable accounts={accounts} categories={categories} hints={hints} />;
  }

  const headersList = await headers();
  const userId = headersList.get("x-user-id") ?? "local";
  const workspaceId = headersList.get("x-workspace-id") ?? "local";
  const [accounts, categories, hints] = await Promise.all([
    getAccounts(userId, workspaceId),
    getCategories(userId, workspaceId),
    getFieldHints(userId, workspaceId),
  ]);

  return <TransactionsRawTable accounts={accounts} categories={categories} hints={hints} />;
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
