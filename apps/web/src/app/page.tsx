import { isDemoMode } from "@/lib/demoMode";
import { DEFAULT_USER_SETTINGS } from "@/lib/locale";
import { getLocaleCookie } from "@/lib/localeCookie";
import { t } from "@/i18n/serverT";
import { extractUserIdFromHeaders, extractWorkspaceIdFromHeaders } from "@/server/userId";
import { getUserSettings } from "@/server/userSettings";
import { headers } from "next/headers";

export default async function HomePage() {
  const demo = await isDemoMode();
  let locale = DEFAULT_USER_SETTINGS.locale;
  if (demo) {
    locale = await getLocaleCookie();
  } else {
    try {
      const headersList = await headers();
      const userId = extractUserIdFromHeaders(headersList);
      const workspaceId = extractWorkspaceIdFromHeaders(headersList);
      const settings = await getUserSettings(userId, workspaceId);
      locale = settings.locale;
    } catch {
      locale = await getLocaleCookie();
    }
  }

  return (
    <main className="container">
      <section className="panel">
        <h1 className="title">{t(locale, "brand.full")}</h1>
        <ul className="link-list">
          <li><a href="/budget">{t(locale, "nav.budget")}</a></li>
          <li><a href="/transactions">{t(locale, "nav.transactions")}</a></li>
          <li><a href="/balances">{t(locale, "nav.balances")}</a></li>
          <li><a href="/dashboards">{t(locale, "nav.dashboards")}</a></li>
          <li><a href="/chat">{t(locale, "nav.chat")}</a></li>
        </ul>
      </section>
    </main>
  );
}
