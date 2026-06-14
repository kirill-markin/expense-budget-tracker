import type { ReactElement } from "react";

import { getLocaleCookie } from "@/lib/localeCookie";
import { t } from "@/i18n/serverT";

import styles from "@/ui/public-share/PublicMonthlyShareTable.module.css";

const SITE_HREF = "https://expense-budget-tracker.com/";

export default async function NotFound(): Promise<ReactElement> {
  const locale = await getLocaleCookie();

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headingGroup}>
          <p className={styles.eyebrow}>{t(locale, "publicShare.title")}</p>
          <h1 className={styles.title}>{t(locale, "publicShare.notFound")}</h1>
        </div>
      </header>
      <footer className={styles.footer}>
        <a href={SITE_HREF}>{t(locale, "publicShare.publishedWithAttribution")}</a>
      </footer>
    </main>
  );
}
