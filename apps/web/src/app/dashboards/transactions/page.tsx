import { Suspense } from "react";
import { headers } from "next/headers";

import { getAccounts } from "@/server/transactions/getTransactions";
import { TransactionsRawTable } from "@/ui/tables/TransactionsRawTable";
import { LoadingIndicator } from "@/ui/LoadingIndicator";

export const dynamic = "force-dynamic";

async function TransactionsData() {
  const headersList = await headers();
  const userId = headersList.get("x-user-id") ?? "local";
  const accounts = await getAccounts(userId);

  return <TransactionsRawTable accounts={accounts} />;
}

export default function TransactionsDashboardPage() {
  return (
    <main className="container">
      <nav className="breadcrumbs">
        <a href="/">Home</a>
        <span className="breadcrumbs-sep">/</span>
        <span>Transactions</span>
      </nav>

      <section className="panel">
        <h1 className="title">Transactions</h1>

        <Suspense fallback={<LoadingIndicator />}>
          <TransactionsData />
        </Suspense>
      </section>
    </main>
  );
}
