"use client";

import { Fragment, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { ColumnEntry } from "@/ui/tables/budget/budgetTableLogic";
import { isFutureMonth, isPastMonth } from "@/ui/tables/budget/budgetTableLogic";
import styles from "@/ui/tables/budget/BudgetTable.module.css";

export type BudgetTableHeaderProps = Readonly<{
  columnSequence: ReadonlyArray<ColumnEntry>;
  currentMonth: string;
  currentYear: string;
  isLoadingLeft: boolean;
}>;

export const BudgetTableHeader = (props: BudgetTableHeaderProps): ReactElement => {
  const { columnSequence, currentMonth, currentYear, isLoadingLeft } = props;
  const { t } = useTranslation();

  return (
    <thead>
      <tr>
        <th className={`${styles.headCell} ${styles.stickyCol}`}>{t("budget.category")}</th>
        <th className={styles.leftSpacer} rowSpan={2}>{isLoadingLeft ? t("common.loading") : ""}</th>
        {columnSequence.map((column) => {
          if (column.kind === "year-total") {
            return (
              <th
                key={`total-${column.year}`}
                className={`${styles.headCell} ${styles.yearTotal}`}
                colSpan={column.year === currentYear ? 2 : 1}
              >
                {t("budget.total")} {column.year}
              </th>
            );
          }

          return (
            <th
              key={column.month}
              className={`${styles.headCell}${column.month === currentMonth ? ` ${styles.currentMonth}` : ""}`}
              colSpan={column.month === currentMonth ? 2 : 1}
              data-month={column.month}
            >
              {column.month}
            </th>
          );
        })}
      </tr>
      <tr>
        <th className={`${styles.headCell} ${styles.stickyCol}`} />
        {columnSequence.map((column) => {
          if (column.kind === "year-total") {
            if (column.year < currentYear) {
              return <th key={`total-${column.year}`} className={`${styles.subHeadCell} ${styles.yearTotal}`}>{t("budget.actual")}</th>;
            }
            if (column.year > currentYear) {
              return <th key={`total-${column.year}`} className={`${styles.subHeadCell} ${styles.yearTotal}`}>{t("budget.plan")}</th>;
            }
            return (
              <Fragment key={`total-${column.year}`}>
                <th className={`${styles.subHeadCell} ${styles.yearTotal}`}>{t("budget.plan")}</th>
                <th className={`${styles.subHeadCell} ${styles.yearTotal}`}>{t("budget.actual")}</th>
              </Fragment>
            );
          }

          if (isPastMonth(column.month, currentMonth)) {
            return <th key={column.month} className={styles.subHeadCell}>{t("budget.actual")}</th>;
          }
          if (isFutureMonth(column.month, currentMonth)) {
            return <th key={column.month} className={styles.subHeadCell}>{t("budget.plan")}</th>;
          }
          return (
            <Fragment key={column.month}>
              <th className={`${styles.subHeadCell} ${styles.currentMonthPlan}`}>{t("budget.plan")}</th>
              <th className={`${styles.subHeadCell} ${styles.currentMonthActual}`}>{t("budget.actual")}</th>
            </Fragment>
          );
        })}
      </tr>
    </thead>
  );
};
