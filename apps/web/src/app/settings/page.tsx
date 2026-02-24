import { Suspense } from "react";
import { headers } from "next/headers";

import { isDemoMode } from "@/lib/demoMode";
import { getAvailableCurrencies } from "@/server/getAvailableCurrencies";
import { getReportCurrency } from "@/server/reportCurrency";
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
    getAvailableCurrencies(userId, workspaceId),
  ]);

  return <WorkspaceSettings reportingCurrency={reportingCurrency} availableCurrencies={availableCurrencies} />;
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
    </main>
  );
}
