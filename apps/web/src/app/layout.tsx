import type { Metadata } from "next";
import { headers } from "next/headers";

import { isDemoMode } from "@/lib/demoMode";
import { getReportCurrency } from "@/server/reportCurrency";
import { AccountMenu } from "@/ui/AccountMenu";
import { CurrencySelector } from "@/ui/CurrencySelector";
import { DemoModeToggle } from "@/ui/DemoModeToggle";

import "./globals.css";

export const metadata: Metadata = {
  title: "Expense Budget Tracker",
  description: "Personal finance tracker",
};

export default async function RootLayout(props: Readonly<{ children: React.ReactNode }>) {
  const { children } = props;
  const demo = await isDemoMode();

  let reportingCurrency = "USD";
  if (!demo) {
    const headersList = await headers();
    const userId = headersList.get("x-user-id") ?? "local";
    const workspaceId = headersList.get("x-workspace-id") ?? "local";
    reportingCurrency = await getReportCurrency(userId, workspaceId);
  }

  return (
    <html lang="en">
      <body>
        {demo && (
          <div className="demo-banner">
            Demo mode — data is static, writes are discarded
          </div>
        )}
        <header className="topbar">
          <a href="/" className="topbar-brand">Expense Budget Tracker</a>
          <div className="topbar-actions">
            <DemoModeToggle isDemoMode={demo} />
            <AccountMenu authEnabled={process.env.AUTH_MODE === "proxy"} />
          </div>
        </header>
        <nav className="nav">
          <a href="/budget">Budget</a>
          <a href="/transactions">Transactions</a>
          <a href="/balances">Balances</a>
          <a href="/dashboards">Dashboard</a>
          <a href="/settings">Settings</a>
          <CurrencySelector initialCurrency={reportingCurrency} />
        </nav>
        {children}
      </body>
    </html>
  );
}
