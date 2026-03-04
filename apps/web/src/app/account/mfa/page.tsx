import { headers } from "next/headers";

import { isDemoMode } from "@/lib/demoMode";
import { DEFAULT_USER_SETTINGS } from "@/lib/locale";
import { getLocaleCookie } from "@/lib/localeCookie";
import { t } from "@/i18n/serverT";
import { getUserSettings } from "@/server/userSettings";
import { MfaSetup } from "@/ui/MfaSetup";

export const dynamic = "force-dynamic";

export default async function MfaPage() {
  const authEnabled = (process.env.AUTH_MODE ?? "none") === "proxy";

  const demo = await isDemoMode();
  let locale = DEFAULT_USER_SETTINGS.locale;
  if (demo) {
    locale = await getLocaleCookie();
  } else {
    try {
      const headersList = await headers();
      const userId = headersList.get("x-user-id") ?? "local";
      const workspaceId = headersList.get("x-workspace-id") ?? "local";
      const settings = await getUserSettings(userId, workspaceId);
      locale = settings.locale;
    } catch {
      locale = await getLocaleCookie();
    }
  }

  return (
    <main className="container">
      <section className="panel">
        <h1 className="title">{t(locale, "account.twoFactorAuth")}</h1>
        <MfaSetup authEnabled={authEnabled} />
      </section>
    </main>
  );
}
