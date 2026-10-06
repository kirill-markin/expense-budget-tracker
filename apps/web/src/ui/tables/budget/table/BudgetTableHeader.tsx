"use client";

import { Fragment, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { BudgetPlansMode, ColumnEntry } from "@/ui/tables/budget/budgetTableLogic";
import { isPastMonth, isSplitBudgetMonth, isSplitBudgetYear } from "@/ui/tables/budget/budgetTableLogic";
import styles from "@/ui/tables/budget/BudgetTable.module.css";
import { buildMonthDividerClass } from "./sections/shared";

export type BudgetTableHeaderProps = Readonly<{
  columnSequence: ReadonlyArray<ColumnEntry>;
  currentMonth: string;
  currentYear: string;
  plansMode: BudgetPlansMode;
}>;

export const BudgetTableHeader = (props: BudgetTableHeaderProps): ReactElement => {
  const { columnSequence, currentMonth, currentYear, plansMode } = props;
  const { t } = useTranslation();

  return (
    <thead>
      <tr>
        <th className={`${styles.headCell} ${styles.stickyCol}`}>{t("budget.category")}</th>
        {columnSequence.map((column, index) => {
          if (column.kind === "year-total") {
            return (
              <th
                key={`total-${column.year}`}
                className={`${styles.headCell} ${styles.yearTotal}`}
                colSpan={isSplitBudgetYear(column.year, currentYear, plansMode) ? 2 : 1}
                data-budget-year-total={column.year}
              >
                {t("budget.total")} {column.year}
              </th>
            );
          }

          const monthDividerClass = buildMonthDividerClass(columnSequence, index, currentMonth, plansMode);
          return (
            <th
              key={column.month}
              className={`${styles.headCell}${monthDividerClass}${column.month === currentMonth ? ` ${styles.currentMonth}` : ""}`}
              colSpan={isSplitBudgetMonth(column.month, currentMonth, plansMode) ? 2 : 1}
              data-month={column.month}
              data-budget-month={column.month}
            >
              {column.month}
            </th>
          );
        })}
      </tr>
      <tr>
        <th className={`${styles.headCell} ${styles.stickyCol}`} />
        {columnSequence.map((column, index) => {
          if (column.kind === "year-total") {
            if (isSplitBudgetYear(column.year, currentYear, plansMode)) {
              return (
                <Fragment key={`total-${column.year}`}>
                  <th className={`${styles.subHeadCell} ${styles.yearTotal}`}>{t("budget.plan")}</th>
                  <th className={`${styles.subHeadCell} ${styles.yearTotal}`}>{t("budget.actual")}</th>
                </Fragment>
              );
            }
            if (column.year < currentYear) {
              return <th key={`total-${column.year}`} className={`${styles.subHeadCell} ${styles.yearTotal}`}>{t("budget.actual")}</th>;
            }
            return <th key={`total-${column.year}`} className={`${styles.subHeadCell} ${styles.yearTotal}`}>{t("budget.plan")}</th>;
          }

          const monthDividerClass = buildMonthDividerClass(columnSequence, index, currentMonth, plansMode);
          if (isSplitBudgetMonth(column.month, currentMonth, plansMode)) {
            // Only the real current month carries the emphasis box.
            const planEmphasisClass = column.month === currentMonth ? ` ${styles.currentMonthPlan}` : "";
            const actualEmphasisClass = column.month === currentMonth ? ` ${styles.currentMonthActual}` : "";
            return (
              <Fragment key={column.month}>
                <th className={`${styles.subHeadCell}${monthDividerClass}${planEmphasisClass}`}>{t("budget.plan")}</th>
                <th className={`${styles.subHeadCell}${actualEmphasisClass}`}>{t("budget.actual")}</th>
              </Fragment>
            );
          }
          if (isPastMonth(column.month, currentMonth)) {
            return <th key={column.month} className={`${styles.subHeadCell}${monthDividerClass}`}>{t("budget.actual")}</th>;
          }
          return <th key={column.month} className={`${styles.subHeadCell}${monthDividerClass}`}>{t("budget.plan")}</th>;
        })}
      </tr>
    </thead>
  );
};
