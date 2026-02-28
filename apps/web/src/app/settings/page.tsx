import { Suspense } from "react";
import { headers } from "next/headers";

import { isDemoMode } from "@/lib/demoMode";
import { listApiKeys } from "@/server/apiKeys";
import { getDemoCategories } from "@/server/demo/data";
import { getFilteredCategories } from "@/server/filteredCategories";
import { getAvailableCurrencies } from "@/server/getAvailableCurrencies";
import { getReportCurrency } from "@/server/reportCurrency";
import { getCategories } from "@/server/transactions/getTransactions";
import { ApiKeyManager } from "@/ui/ApiKeyManager";
import { FilteredCategorySettings } from "@/ui/FilteredCategorySettings";
import { WorkspaceSettings } from "@/ui/WorkspaceSettings";
import { LoadingIndicator } from "@/ui/LoadingIndicator";

export const dynamic = "force-dynamic";

async function SettingsData() {
  const demo = await isDemoMode();

  if (demo) {
    return <WorkspaceSettings reportingCurrency="USD" availableCurrencies={["EUR", "GBP", "USD"]} />;
  }

  const headersList = await headers();
  const userId = headersList.get("x-user-id") ?? "local";
  const workspaceId = headersList.get("x-workspace-id") ?? "local";

  const [reportingCurrency, availableCurrencies] = await Promise.all([
    getReportCurrency(userId, workspaceId),
    getAvailableCurrencies(),
  ]);

  const currencies = availableCurrencies.includes(reportingCurrency)
    ? availableCurrencies
    : [...availableCurrencies, reportingCurrency].toSorted();

  return <WorkspaceSettings reportingCurrency={reportingCurrency} availableCurrencies={currencies} />;
}

async function FilteredCategoriesData() {
  const demo = await isDemoMode();

  if (demo) {
    return <FilteredCategorySettings filteredCategories={null} allCategories={getDemoCategories()} />;
  }

  const headersList = await headers();
  const userId = headersList.get("x-user-id") ?? "local";
  const workspaceId = headersList.get("x-workspace-id") ?? "local";

  const [filteredCategories, allCategories] = await Promise.all([
    getFilteredCategories(userId, workspaceId),
    getCategories(userId, workspaceId),
  ]);

  return <FilteredCategorySettings filteredCategories={filteredCategories} allCategories={allCategories} />;
}

async function ApiKeyData() {
  const demo = await isDemoMode();

  if (demo) {
    return null;
  }

  const headersList = await headers();
  const userId = headersList.get("x-user-id") ?? "local";
  const workspaceId = headersList.get("x-workspace-id") ?? "local";

  const initialKeys = await listApiKeys(userId, workspaceId);

  return <ApiKeyManager initialKeys={initialKeys} />;
}

export default function SettingsPage() {
  return (
    <main className="container">
      <section className="panel">
        <h1 className="title">Workspace Settings</h1>

        <Suspense fallback={<LoadingIndicator />}>
          <SettingsData />
        </Suspense>
      </section>

      <section className="panel">
        <h1 className="title">Filtered Categories</h1>

        <Suspense fallback={<LoadingIndicator />}>
          <FilteredCategoriesData />
        </Suspense>
      </section>

      <section className="panel">
        <h1 className="title">API Keys</h1>

        <Suspense fallback={<LoadingIndicator />}>
          <ApiKeyData />
        </Suspense>
      </section>

    </main>
  );
}
