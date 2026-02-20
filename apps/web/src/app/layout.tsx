import type { Metadata } from "next";
import { cookies } from "next/headers";

import "./globals.css";

export const metadata: Metadata = {
  title: "Expense Budget Tracker",
  description: "Personal finance tracker",
};

export default async function RootLayout(props: Readonly<{ children: React.ReactNode }>) {
  const { children } = props;
  const authEnabled = process.env.SESSION_SECRET !== undefined && process.env.SESSION_SECRET !== "";
  const cookieStore = await cookies();
  const hasSession = cookieStore.has("session");
  const showTopbar = !authEnabled || hasSession;

  return (
    <html lang="en">
      <body>
        {showTopbar && (
          <header className="topbar">
            <a href="/" className="topbar-brand">expense-budget-tracker</a>
            {authEnabled && (
              <form action="/api/auth/logout" method="POST" className="topbar-logout-form">
                <button type="submit" className="topbar-logout">Logout</button>
              </form>
            )}
          </header>
        )}
        {children}
      </body>
    </html>
  );
}
