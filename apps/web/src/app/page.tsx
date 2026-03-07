import { isDemoMode } from "@/lib/demoMode";
import { DEFAULT_USER_SETTINGS } from "@/lib/locale";
import { getLocaleCookie } from "@/lib/localeCookie";
import { NAV_LINKS } from "@/lib/navigation";
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
      const initialLocale = await getLocaleCookie();
      const settings = await getUserSettings(userId, workspaceId, initialLocale);
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
          {NAV_LINKS.map((link) => (
            <li key={link.href}><a href={link.href}>{t(locale, link.labelKey)}</a></li>
          ))}
        </ul>
      </section>
    </main>
  );
}
