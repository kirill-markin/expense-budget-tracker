import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Expense Budget Tracker",
  description: "Personal finance tracker",
};

export default function RootLayout(props: Readonly<{ children: React.ReactNode }>) {
  const { children } = props;

  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <a href="/" className="topbar-brand">expense-budget-tracker</a>
        </header>
        {children}
      </body>
    </html>
  );
}
