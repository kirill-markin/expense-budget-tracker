import type { Metadata } from "next";
import { headers } from "next/headers";

import { readChatCookies } from "@/lib/chatCookies";
import { isDemoMode } from "@/lib/demoMode";
import { listWorkspaces, type WorkspaceSummary } from "@/server/listWorkspaces";
import { getReportCurrency } from "@/server/reportCurrency";
import { AccountMenu } from "@/ui/AccountMenu";
import { ChatLayoutProvider } from "@/ui/chat/ChatLayoutProvider";
import { ChatLayoutShell } from "@/ui/chat/ChatLayoutShell";
import { CurrencySelector } from "@/ui/CurrencySelector";
import { FilteredBanner } from "@/ui/FilteredBanner";
import { FilteredModeProvider } from "@/ui/FilteredModeProvider";
import { ModeToggle } from "@/ui/ModeToggle";

import "./globals.css";

export const metadata: Metadata = {
  title: "Expense Budget Tracker",
  description: "Personal finance tracker",
};

export default async function RootLayout(props: Readonly<{ children: React.ReactNode }>) {
  const { children } = props;
  const demo = await isDemoMode();
  const { chatOpen, chatWidth } = await readChatCookies();

  const authEnabled = process.env.AUTH_MODE === "proxy";
  let reportingCurrency = "USD";
  let workspaces: ReadonlyArray<WorkspaceSummary> = [];
  let currentWorkspaceId = "";
  if (!demo) {
    try {
      const headersList = await headers();
      const userId = headersList.get("x-user-id") ?? "local";
      let workspaceId = headersList.get("x-workspace-id") ?? "local";
      try {
        reportingCurrency = await getReportCurrency(userId, workspaceId);
      } catch {
        workspaceId = userId;
        reportingCurrency = await getReportCurrency(userId, workspaceId);
      }
      currentWorkspaceId = workspaceId;
      if (authEnabled) {
        workspaces = await listWorkspaces(userId, workspaceId);
      }
    } catch (err) {
      console.error("Layout DB unavailable, using defaults: %s", err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <html lang="en">
      <body>
        <FilteredModeProvider isDemoMode={demo}>
          <div className="header-sticky">
            {demo && (
              <div className="demo-banner">
                Demo mode<span className="demo-banner-detail"> — data is static, writes are discarded</span>
              </div>
            )}
            <FilteredBanner />
            <header className="topbar">
              <a href="/" className="topbar-brand">
                <span className="brand-full">Expense Budget Tracker</span>
                <span className="brand-short">EBT</span>
              </a>
              <div className="topbar-actions">
                <ModeToggle isDemoMode={demo} />
                <AccountMenu
                  authEnabled={authEnabled}
                  workspaces={workspaces}
                  currentWorkspaceId={currentWorkspaceId}
                />
              </div>
            </header>
            <nav className="nav">
              <a href="/budget">Budget</a>
              <a href="/transactions">Transactions</a>
              <a href="/balances">Balances</a>
              <a href="/dashboards">Dashboard</a>
              <a href="/settings">Settings</a>
              <a href="/chat">Chat</a>
              <CurrencySelector initialCurrency={reportingCurrency} />
            </nav>
          </div>
          <ChatLayoutProvider initialChatOpen={chatOpen} initialChatWidth={chatWidth}>
            <ChatLayoutShell>
              {children}
            </ChatLayoutShell>
          </ChatLayoutProvider>
        </FilteredModeProvider>
      </body>
    </html>
  );
}
