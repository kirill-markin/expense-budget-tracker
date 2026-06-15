"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { SupportedLocale } from "@/lib/locale";
import type { PublicMonthlyCategoryShare } from "@/server/community/publicMonthlyCategoryShareTypes";
import { buildPublicMonthlyShareJsonHref, fetchPublicMonthlyShareWindow } from "@/ui/public-share/publicMonthlyShareClient";
import {
  buildEarlierPublicMonthlyShareWindow,
  buildPublicMonthlyShareTableModel,
  mergePublicMonthlyShareWindows,
  PUBLIC_MONTHLY_SHARE_BACKFILL_WINDOW_MONTHS,
  resolvePublicMonthlyShareLabel,
  type PublicMonthlyShareWindow,
} from "@/ui/public-share/publicMonthlyShareModel";
import { PublicMonthlyShareTable } from "@/ui/public-share/PublicMonthlyShareTable";

import styles from "./PublicMonthlyShareTable.module.css";

type PublicMonthlySharePageProps = Readonly<{
  token: string;
  initialShare: PublicMonthlyCategoryShare;
  initialJsonWindow: PublicMonthlyShareWindow;
  locale: SupportedLocale;
  siteHref: string;
}>;

const parseMonthDate = (month: string): Date =>
  new Date(`${month}-01T00:00:00.000Z`);

const formatMonth = (
  month: string,
  formatter: Intl.DateTimeFormat,
): string =>
  formatter.format(parseMonthDate(month));

const buildRangeText = (
  monthFrom: string | null,
  monthTo: string | null,
  formatter: Intl.DateTimeFormat,
): string | null => {
  if (monthFrom === null || monthTo === null) {
    return null;
  }
  if (monthFrom === monthTo) {
    return formatMonth(monthFrom, formatter);
  }
  return `${formatMonth(monthFrom, formatter)} - ${formatMonth(monthTo, formatter)}`;
};

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const PublicMonthlySharePage = (props: PublicMonthlySharePageProps): ReactElement => {
  const {
    token,
    initialShare,
    initialJsonWindow,
    locale,
    siteHref,
  } = props;
  const { t } = useTranslation();
  const [share, setShare] = useState<PublicMonthlyCategoryShare>(initialShare);
  const [isHydrated, setIsHydrated] = useState<boolean>(false);
  const [isLoadingEarlier, setIsLoadingEarlier] = useState<boolean>(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const isLoadingEarlierRef = useRef<boolean>(false);

  const model = useMemo(
    (): ReturnType<typeof buildPublicMonthlyShareTableModel> =>
      buildPublicMonthlyShareTableModel(share),
    [share],
  );
  const monthFormatter = useMemo(
    (): Intl.DateTimeFormat =>
      new Intl.DateTimeFormat(locale, {
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      }),
    [locale],
  );
  const visibleLabel = resolvePublicMonthlyShareLabel(share.label, t("publicShare.anonymousUser"));
  const availableRangeText = buildRangeText(share.availableMonthFrom, share.availableMonthTo, monthFormatter);
  const jsonWindow = share.loadedMonthFrom === null || share.loadedMonthTo === null
    ? initialJsonWindow
    : {
      monthFrom: share.loadedMonthFrom,
      monthTo: share.loadedMonthTo,
    };
  const jsonHref = buildPublicMonthlyShareJsonHref(token, jsonWindow);
  const earlierWindow = buildEarlierPublicMonthlyShareWindow(
    share.loadedMonthFrom,
    share.availableMonthFrom,
    PUBLIC_MONTHLY_SHARE_BACKFILL_WINDOW_MONTHS,
  );
  const canLoadEarlier = earlierWindow !== null;

  useEffect((): void => {
    setIsHydrated(true);
  }, []);

  const handleLoadEarlier = useCallback(async (): Promise<void> => {
    if (isLoadingEarlierRef.current) {
      return;
    }

    const window = buildEarlierPublicMonthlyShareWindow(
      share.loadedMonthFrom,
      share.availableMonthFrom,
      PUBLIC_MONTHLY_SHARE_BACKFILL_WINDOW_MONTHS,
    );
    if (window === null) {
      return;
    }

    isLoadingEarlierRef.current = true;
    setIsLoadingEarlier(true);
    setLoadError(null);

    try {
      const fetchedShare = await fetchPublicMonthlyShareWindow(token, window);
      setShare((currentShare) => mergePublicMonthlyShareWindows(currentShare, fetchedShare));
    } catch (error) {
      setLoadError(toErrorMessage(error));
    } finally {
      isLoadingEarlierRef.current = false;
      setIsLoadingEarlier(false);
    }
  }, [share.availableMonthFrom, share.loadedMonthFrom, token]);

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headingGroup}>
          <p className={styles.eyebrow}>{t("publicShare.title")}</p>
          <h1 className={styles.title}>{visibleLabel}</h1>
          <p className={styles.meta}>
            {[share.currency, availableRangeText].filter((value): value is string => value !== null).join(" - ")}
          </p>
        </div>
        <div className={styles.actions}>
          <a className={styles.jsonLink} href={jsonHref} download>
            {t("publicShare.downloadJson")}
          </a>
        </div>
      </header>

      <section className={styles.tableArea} aria-label={t("publicShare.title")}>
        <div className={styles.tableStatus}>
          {model.hasSelectedCategories && canLoadEarlier && (
            <button
              className={styles.loadEarlierButton}
              data-testid="public-share-load-earlier"
              type="button"
              disabled={!isHydrated || isLoadingEarlier}
              onClick={(): void => {
                void handleLoadEarlier();
              }}
            >
              {isLoadingEarlier ? t("common.loading") : t("publicShare.loadEarlier")}
            </button>
          )}
          {loadError !== null && <span className={styles.error}>{loadError}</span>}
        </div>
        {!model.hasSelectedCategories ? (
          <p className={styles.empty}>{t("publicShare.emptyNoSelectedCategories")}</p>
        ) : (
          <PublicMonthlyShareTable
            model={model}
            currency={share.currency}
            locale={locale}
            canLoadEarlier={canLoadEarlier}
            isLoadingEarlier={isLoadingEarlier}
            onLoadEarlier={handleLoadEarlier}
          />
        )}
      </section>

      <footer className={styles.footer}>
        <a href={siteHref}>{t("publicShare.publishedWithAttribution")}</a>
      </footer>
    </main>
  );
};
