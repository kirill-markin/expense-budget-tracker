import type { Metadata } from "next";

import { isDemoMode } from "@/lib/demoMode";
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
          <a href="/" className="topbar-brand">expense-budget-tracker</a>
          <DemoModeToggle isDemoMode={demo} />
        </header>
        {children}
      </body>
    </html>
  );
}
