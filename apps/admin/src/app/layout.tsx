import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import Link from "next/link";

import { ADMIN_EMAIL_HEADER } from "@/server/identity";

import "./globals.css";

export const metadata: Metadata = {
  title: "Expense Budget Tracker Admin",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

// tokens.css defines the dark palette only under [data-theme="dark"], so the
// attribute follows the system preference, including later changes.
const THEME_SCRIPT = `(() => {
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => {
    document.documentElement.dataset.theme = query.matches ? "dark" : "light";
  };
  apply();
  query.addEventListener("change", apply);
})();`;

export default async function RootLayout(props: Readonly<{ children: React.ReactNode }>) {
  const { children } = props;
  const headersList = await headers();
  const nonce = headersList.get("x-nonce") ?? undefined;
  // Absent on /forbidden, which proxy.ts serves without an admin identity.
  const adminEmail = headersList.get(ADMIN_EMAIL_HEADER);

  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <head>
        <meta name="robots" content="noindex" />
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <header className="admin-header">
          <span className="admin-brand">Admin</span>
          {adminEmail !== null && (
            <>
              <nav className="admin-nav" aria-label="Admin sections">
                <Link href="/analytics/level-1-metrics">Level 1 metrics</Link>
                <Link href="/users">Users</Link>
              </nav>
              <span className="admin-account" data-testid="admin-email">{adminEmail}</span>
            </>
          )}
        </header>
        <main className="admin-main">{children}</main>
      </body>
    </html>
  );
}
