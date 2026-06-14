"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { SupportedLocale } from "@/lib/locale";
import type { PublicMonthlyShareTableModel } from "@/ui/public-share/publicMonthlyShareModel";

import styles from "./PublicMonthlyShareTable.module.css";

const SCROLL_LOAD_THRESHOLD_PX = 200;

type PublicMonthlyShareTableProps = Readonly<{
  model: PublicMonthlyShareTableModel;
  currency: string;
  locale: SupportedLocale;
  canLoadEarlier: boolean;
  isLoadingEarlier: boolean;
  onLoadEarlier: () => Promise<void>;
}>;

const parseMonthDate = (month: string): Date =>
  new Date(`${month}-01T00:00:00.000Z`);

const formatMonthHeader = (
  month: string,
  formatter: Intl.DateTimeFormat,
): string =>
  formatter.format(parseMonthDate(month));

export const PublicMonthlyShareTable = (props: PublicMonthlyShareTableProps): ReactElement => {
  const {
    model,
    currency,
    locale,
    canLoadEarlier,
    isLoadingEarlier,
    onLoadEarlier,
  } = props;
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const previousScrollWidthRef = useRef<number>(0);
  const isPrependingRef = useRef<boolean>(false);
  const isRtl = typeof document !== "undefined" && document.documentElement.dir === "rtl";

  const amountFormatter = useMemo(
    (): Intl.NumberFormat =>
      new Intl.NumberFormat(locale, {
        style: "currency",
        currency,
      }),
    [currency, locale],
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

  const markPrependPending = useCallback((): void => {
    const scrollElement = scrollRef.current;
    if (scrollElement === null || isPrependingRef.current) {
      return;
    }
    previousScrollWidthRef.current = scrollElement.scrollWidth;
    isPrependingRef.current = true;
  }, []);

  useLayoutEffect((): void => {
    if (!isPrependingRef.current) {
      return;
    }

    const scrollElement = scrollRef.current;
    if (scrollElement === null) {
      return;
    }

    const scrollDelta = scrollElement.scrollWidth - previousScrollWidthRef.current;
    if (scrollDelta <= 0) {
      if (!isLoadingEarlier) {
        isPrependingRef.current = false;
      }
      return;
    }

    isPrependingRef.current = false;
    scrollElement.scrollLeft += isRtl ? -scrollDelta : scrollDelta;
  });

  useEffect((): (() => void) | void => {
    const scrollElement = scrollRef.current;
    if (scrollElement === null) {
      return undefined;
    }

    let rafId = 0;
    const handleScroll = (): void => {
      if (rafId !== 0) {
        return;
      }

      rafId = requestAnimationFrame((): void => {
        rafId = 0;
        const scrollStart = isRtl ? -scrollElement.scrollLeft : scrollElement.scrollLeft;
        if (scrollStart >= SCROLL_LOAD_THRESHOLD_PX || !canLoadEarlier || isLoadingEarlier) {
          return;
        }

        markPrependPending();
        void onLoadEarlier();
      });
    };

    scrollElement.addEventListener("scroll", handleScroll, { passive: true });
    return (): void => {
      scrollElement.removeEventListener("scroll", handleScroll);
      if (rafId !== 0) {
        cancelAnimationFrame(rafId);
      }
    };
  }, [canLoadEarlier, isLoadingEarlier, isRtl, markPrependPending, onLoadEarlier]);

  useEffect((): (() => void) | void => {
    const scrollElement = scrollRef.current;
    if (scrollElement === null) {
      return undefined;
    }

    const tableHead = scrollElement.querySelector<HTMLElement>("thead");
    if (tableHead === null) {
      return undefined;
    }

    let startX = 0;
    let startScrollLeft = 0;

    const onMouseMove = (event: MouseEvent): void => {
      scrollElement.scrollLeft = startScrollLeft - (event.pageX - startX);
    };

    const onMouseUp = (): void => {
      scrollElement.classList.remove(styles.dragging);
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    const onMouseDown = (event: MouseEvent): void => {
      event.preventDefault();
      startX = event.pageX;
      startScrollLeft = scrollElement.scrollLeft;
      scrollElement.classList.add(styles.dragging);
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    };

    tableHead.addEventListener("mousedown", onMouseDown);
    return (): void => {
      tableHead.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  return (
    <div className={styles.scroll} ref={scrollRef}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th className={`${styles.headCell} ${styles.stickyCol} ${styles.categoryHead}`} scope="col">
              {t("publicShare.tableCategory")}
            </th>
            {model.columns.map((column): ReactElement => {
              if (column.kind === "month") {
                return (
                  <th key={`month-${column.month}`} className={styles.headCell} scope="col" data-month={column.month}>
                    {formatMonthHeader(column.month, monthFormatter)}
                  </th>
                );
              }
              return (
                <th key={`year-${column.year}`} className={`${styles.headCell} ${styles.yearTotal}`} scope="col">
                  {column.year} {t("publicShare.tableTotal")}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {model.rows.map((row): ReactElement => (
            <tr
              key={`${row.accessLevel}-${row.category}`}
              className={row.accessLevel === "category_only" ? styles.categoryOnlyRow : undefined}
            >
              <th className={`${styles.categoryCell} ${styles.stickyCol}`} scope="row">
                {row.category}
              </th>
              {model.columns.map((column): ReactElement => {
                const key = column.kind === "month"
                  ? `${row.category}-${column.month}`
                  : `${row.category}-${column.year}`;

                if (row.accessLevel === "category_only") {
                  return (
                    <td
                      key={key}
                      className={`${styles.cell} ${column.kind === "year-total" ? styles.yearTotal : ""} ${styles.maskedCell}`}
                      aria-label={t("publicShare.categoryOnlyMaskedValue")}
                    >
                      <span className={styles.maskedText}>{t("publicShare.categoryOnlyMaskedValue")}</span>
                    </td>
                  );
                }

                if (column.kind === "month") {
                  return (
                    <td key={key} className={styles.cell} data-month={column.month}>
                      {amountFormatter.format(row.monthAmounts.get(column.month) ?? 0)}
                    </td>
                  );
                }

                return (
                  <td key={key} className={`${styles.cell} ${styles.yearTotal}`}>
                    {amountFormatter.format(row.yearTotals.get(column.year) ?? 0)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
