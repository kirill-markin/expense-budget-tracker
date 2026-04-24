import { Suspense } from "react";
import { headers } from "next/headers";

import { isDemoMode } from "@/lib/demoMode";
import { DEFAULT_USER_SETTINGS } from "@/lib/locale";
import { getLocaleCookie } from "@/lib/localeCookie";
import { t } from "@/i18n/serverT";
import { getFieldHints, getTransactionsFilterOptions } from "@/server/transactions/getTransactions";
import { extractUserIdFromHeaders, extractWorkspaceIdFromHeaders } from "@/server/userId";
import { getUserSettings } from "@/server/userSettings";
import { getDemoFieldHints, getDemoTransactionsFilterOptions } from "@/server/demo/data";
import { TransactionsRawTable } from "@/ui/tables/transactions/TransactionsRawTable";
import { LoadingIndicator } from "@/ui/LoadingIndicator";

export const dynamic = "force-dynamic";

async function TransactionsData() {
  const demo = await isDemoMode();
  // A route refresh regenerates this token so the table can refetch live rows
  // against the same refresh boundary as the server-rendered header metadata.
  const refreshToken = crypto.randomUUID();

  if (demo) {
    const filterOptions = getDemoTransactionsFilterOptions();
    const hints = getDemoFieldHints();
    return <TransactionsRawTable filterOptions={filterOptions} hints={hints} refreshToken={refreshToken} />;
  }

  const headersList = await headers();
  const userId = extractUserIdFromHeaders(headersList);
  const workspaceId = extractWorkspaceIdFromHeaders(headersList);
  const [filterOptions, hints] = await Promise.all([
    getTransactionsFilterOptions(userId, workspaceId),
    getFieldHints(userId, workspaceId),
  ]);

  return <TransactionsRawTable filterOptions={filterOptions} hints={hints} refreshToken={refreshToken} />;
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
      const initialLocale = await getLocaleCookie();
      const settings = await getUserSettings(userId, workspaceId, initialLocale);
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
