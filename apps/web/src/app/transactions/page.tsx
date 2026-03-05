import { Suspense } from "react";
import { headers } from "next/headers";

import { isDemoMode } from "@/lib/demoMode";
import { DEFAULT_USER_SETTINGS } from "@/lib/locale";
import { getLocaleCookie } from "@/lib/localeCookie";
import { t } from "@/i18n/serverT";
import { getAccounts, getCategories, getFieldHints } from "@/server/transactions/getTransactions";
import { extractUserIdFromHeaders, extractWorkspaceIdFromHeaders } from "@/server/userId";
import { getUserSettings } from "@/server/userSettings";
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
  const userId = extractUserIdFromHeaders(headersList);
  const workspaceId = extractWorkspaceIdFromHeaders(headersList);
  const [accounts, categories, hints] = await Promise.all([
    getAccounts(userId, workspaceId),
    getCategories(userId, workspaceId),
    getFieldHints(userId, workspaceId),
  ]);

  return <TransactionsRawTable accounts={accounts} categories={categories} hints={hints} />;
}

export default async function TransactionsDashboardPage() {
  const demo = await isDemoMode();
  let locale = DEFAULT_USER_SETTINGS.locale;
  if (demo) {
    locale = await getLocaleCookie();
  } else {
    try {
      const headersList = await headers();
      const userId = extractUserIdFromHeaders(headersList);
      const workspaceId = extractWorkspaceIdFromHeaders(headersList);
      const settings = await getUserSettings(userId, workspaceId);
      locale = settings.locale;
    } catch {
      locale = await getLocaleCookie();
    }
  }

  return (
    <main className="container">
      <section className="panel">
        <h1 className="title">{t(locale, "nav.transactions")}</h1>

        <Suspense fallback={<LoadingIndicator />}>
          <TransactionsData />
        </Suspense>
      </section>
    </main>
  );
}
