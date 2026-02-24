import type { Metadata } from "next";

import { isDemoMode } from "@/lib/demoMode";
import { AccountMenu } from "@/ui/AccountMenu";
import { DemoModeToggle } from "@/ui/DemoModeToggle";

import "./globals.css";

export const metadata: Metadata = {
  title: "Expense Budget Tracker",
  description: "Personal finance tracker",
};

export default async function RootLayout(props: Readonly<{ children: React.ReactNode }>) {
  const { children } = props;
  const demo = await isDemoMode();

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
          <a href="/dashboards">Dashboard</a>
          <a href="/budget">Budget</a>
          <a href="/transactions">Transactions</a>
          <a href="/balances">Balances</a>
        </nav>
        {children}
      </body>
    </html>
  );
}
