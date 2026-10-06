"use client";

import { Fragment, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { getCellVisibility, MASKED_CELL_PLACEHOLDER } from "@/lib/dataMask";
import type { NumberFormat } from "@/lib/locale";
import { BudgetPlanCell } from "@/ui/tables/budget/BudgetPlanCell";
import {
  getBudgetBaseCellKey,
  type BudgetBaseLocalAcknowledgementByCell,
} from "@/ui/tables/budget/budgetBaseRangeReconciliation";
import type { BudgetAdjustmentRowsController } from "@/ui/tables/budget/controller/budgetAdjustmentRowsController";
import {
  formatAmount,
  isBudgetFillSourceMonth,
  lookupCell,
  zeroCellValue,
  type BudgetPlansMode,
  type ColumnEntry,
  type DirectionBlock,
  type YearTotalComputed,
} from "@/ui/tables/budget/budgetTableLogic";
import styles from "@/ui/tables/budget/BudgetTable.module.css";
import type { DrillDownFilter } from "@/ui/tables/shared/drillDownFilter";
import tableStateStyles from "@/ui/tables/shared/TableStates.module.css";
import {
  buildUnconvertibleCurrenciesTitle,
  buildUnconvertibleMonthsTitle,
} from "@/ui/tables/shared/unconvertibleTitle";
import {
  buildCategoryMonthDrillDownFilter,
  buildCategoryYearDrillDownFilter,
  buildMonthDividerClass,
  buildYearTotalStateClass,
  isDirectionActualOverPlanned,
  renderColumnCells,
  renderDerivedYearLoadingCells,
  renderMaskedYearCells,
  renderUnloadedMonthCells,
} from "../shared";

type CategoryRowProps = Readonly<{
  block: DirectionBlock;
  /** Unfiltered category list of this direction, for the adjustment editor. */
  directionCategories: ReadonlyArray<string>;
  category: string;
  effectiveAllowlist: ReadonlySet<string> | null;
  localBaseAcknowledgementByCell: BudgetBaseLocalAcknowledgementByCell;
  columnSequence: ReadonlyArray<ColumnEntry>;
  currentMonth: string;
  currentYear: string;
  plansMode: BudgetPlansMode;
  loadedFrom: string;
  loadedTo: string;
  yearComputed: ReadonlyMap<string, YearTotalComputed>;
  taintedCells: ReadonlySet<string>;
  unconvertibleCurrenciesByMonth: ReadonlyMap<string, ReadonlyArray<string>>;
  numberFormat: NumberFormat;
  budgetAdjustments: BudgetAdjustmentRowsController;
  copyToClipboard: (value: string) => void;
  openDrillDown: (filter: DrillDownFilter) => void;
  onPlanSave: (
    month: string,
    direction: string,
    category: string,
    value: number,
  ) => void;
  onBaseMutationIssued: (
    month: string,
    direction: string,
    category: string,
  ) => number;
  onFillMonths: (
    sourceMonth: string,
    direction: string,
    category: string,
    baseValue: number,
  ) => number;
  onBaseAcknowledged: (
    month: string,
    direction: string,
    category: string,
    baseValue: number,
    mutationGeneration: number,
  ) => void;
  onFillMonthsAcknowledged: (
    sourceMonth: string,
    direction: string,
    category: string,
    baseValue: number,
    mutationGeneration: number,
  ) => void;
  onSyncStart: () => void;
  onSyncEnd: () => void;
}>;

export const CategoryRow = (props: CategoryRowProps): ReactElement => {
  const {
    block,
    directionCategories,
    category,
    effectiveAllowlist,
    localBaseAcknowledgementByCell,
    columnSequence,
    currentMonth,
    currentYear,
    plansMode,
    loadedFrom,
    loadedTo,
    yearComputed,
    taintedCells,
    unconvertibleCurrenciesByMonth,
    numberFormat,
    budgetAdjustments,
    copyToClipboard,
    openDrillDown,
    onPlanSave,
    onBaseMutationIssued,
    onFillMonths,
    onBaseAcknowledged,
    onFillMonthsAcknowledged,
    onSyncStart,
    onSyncEnd,
  } = props;
  const { t } = useTranslation();
  const categoryVisibility = getCellVisibility(effectiveAllowlist, category);
  const formatUnconvertibleReason = (currencies: string): string =>
    t("common.unconvertibleReason", { currencies });
  const unconvertibleTitle = (
    isTainted: boolean,
    includesMonth: (month: string) => boolean,
  ): string | undefined => (
    isTainted && categoryVisibility.showData
      ? (buildUnconvertibleMonthsTitle(unconvertibleCurrenciesByMonth, includesMonth, formatUnconvertibleReason) ?? undefined)
      : undefined
  );
  /**
   * Year totals come from their own full-year fetch, so their reason comes from
   * that fetch too: the month map only covers the horizontally loaded range.
   */
  const yearUnconvertibleTitle = (
    isTainted: boolean,
    currencies: ReadonlyArray<string>,
  ): string | undefined => (
    isTainted && categoryVisibility.showData
      ? (buildUnconvertibleCurrenciesTitle(currencies, formatUnconvertibleReason) ?? undefined)
      : undefined
  );
  const renderYearLoading = (year: string, isSplitYearValue: boolean): ReactElement => (
    categoryVisibility.showData
      ? renderDerivedYearLoadingCells(year, isSplitYearValue)
      : renderMaskedYearCells(year, isSplitYearValue, categoryVisibility.maskClass)
  );

  return (
    <tr key={category} className={styles.categoryRow}>
      <td
        className={`${styles.categoryLabel} ${styles.stickyCol}${categoryVisibility.showData ? " copyable-cell" : ""}${categoryVisibility.maskClass}`}
        onClick={categoryVisibility.showData ? () => copyToClipboard(category) : undefined}
      >
        {categoryVisibility.showData ? category : MASKED_CELL_PLACEHOLDER}
      </td>
      {columnSequence.map((column, index) => {
        const yearData = column.kind === "year-total" ? yearComputed.get(column.year) : undefined;
        const monthDividerClass = buildMonthDividerClass(columnSequence, index, currentMonth, plansMode);
        return renderColumnCells({
          column,
          currentMonth,
          currentYear,
          plansMode,
          loadedFrom,
          loadedTo,
          isYearLoading: column.kind === "year-total" && yearData === undefined,
          renderYearLoading: (isSplitYearValue) =>
            renderYearLoading(column.kind === "year-total" ? column.year : "", isSplitYearValue),
          renderMonthLoading: (month) =>
            renderUnloadedMonthCells(month, currentMonth, styles.cell, plansMode, monthDividerClass),
          renderPastYear: () => {
            if (column.kind !== "year-total" || yearData === undefined) {
              return renderYearLoading(column.kind === "year-total" ? column.year : "", false);
            }
            const yearCell =
              yearData.directionCategoryTotals.get(block.direction)?.get(category) ?? zeroCellValue;
            const categoryKey = `${block.direction}::${category}`;
            const isYearTainted = yearData.taintedCategories.has(categoryKey);
            const yearCurrencies = yearData.unconvertibleCurrenciesByCategory.get(categoryKey) ?? [];
            const yearTotalStateClass = categoryVisibility.showData
              ? buildYearTotalStateClass(isYearTainted, false)
              : "";
            return (
              <td
                key={`total-${column.year}`}
                className={`${styles.cell} ${styles.yearTotal}${categoryVisibility.maskClass}${yearTotalStateClass}${categoryVisibility.showData ? ` ${styles.cellClickable}` : ""}`}
                title={yearUnconvertibleTitle(isYearTainted, yearCurrencies)}
                data-testid={categoryVisibility.showData
                  ? `budget-year-actual-${column.year}:${block.direction}:${category}`
                  : undefined}
                onClick={categoryVisibility.showData
                  ? () => openDrillDown(buildCategoryYearDrillDownFilter(column.year, block.direction, category))
                  : undefined}
              >
                {categoryVisibility.showData ? formatAmount(yearCell.actual, numberFormat) : MASKED_CELL_PLACEHOLDER}
              </td>
            );
          },
          renderFutureYear: () => {
            if (column.kind !== "year-total" || yearData === undefined) {
              return renderYearLoading(column.kind === "year-total" ? column.year : "", false);
            }
            const yearCell =
              yearData.directionCategoryTotals.get(block.direction)?.get(category) ?? zeroCellValue;
            return (
              <td
                key={`total-${column.year}`}
                className={`${styles.cell} ${styles.yearTotal}${categoryVisibility.maskClass}`}
                data-testid={categoryVisibility.showData
                  ? `budget-year-plan-${column.year}:${block.direction}:${category}`
                  : undefined}
              >
                {categoryVisibility.showData ? formatAmount(yearCell.planned, numberFormat) : MASKED_CELL_PLACEHOLDER}
              </td>
            );
          },
          renderSplitYear: () => {
            if (column.kind !== "year-total" || yearData === undefined) {
              return renderYearLoading(column.kind === "year-total" ? column.year : "", true);
            }
            const yearCell =
              yearData.directionCategoryTotals.get(block.direction)?.get(category) ?? zeroCellValue;
            const isActualOver = isDirectionActualOverPlanned(block.direction, yearCell.planned, yearCell.actual);
            const categoryKey = `${block.direction}::${category}`;
            const isYearTainted = yearData.taintedCategories.has(categoryKey);
            const yearCurrencies = yearData.unconvertibleCurrenciesByCategory.get(categoryKey) ?? [];
            // This year's plan sums the elapsed months' actuals in "actuals"
            // mode, so an unconvertible actual leaves the plan incomplete too.
            const isYearPlanTainted = yearData.planEmbedsActuals && isYearTainted;
            const yearTotalPlanStateClass = categoryVisibility.showData
              ? buildYearTotalStateClass(isYearPlanTainted, false)
              : "";
            const yearTotalActualStateClass = categoryVisibility.showData
              ? buildYearTotalStateClass(isYearTainted, isActualOver)
              : "";
            return (
              <Fragment key={`total-${column.year}`}>
                <td
                  className={`${styles.cell} ${styles.yearTotal}${categoryVisibility.maskClass}${yearTotalPlanStateClass}`}
                  title={yearUnconvertibleTitle(isYearPlanTainted, yearCurrencies)}
                  data-testid={categoryVisibility.showData
                    ? `budget-year-plan-${column.year}:${block.direction}:${category}`
                    : undefined}
                >
                  {categoryVisibility.showData ? formatAmount(yearCell.planned, numberFormat) : MASKED_CELL_PLACEHOLDER}
                </td>
                <td
                  className={`${styles.cell} ${styles.yearTotal}${categoryVisibility.maskClass}${yearTotalActualStateClass}${categoryVisibility.showData ? ` ${styles.cellClickable}` : ""}`}
                  title={yearUnconvertibleTitle(isYearTainted, yearCurrencies)}
                  data-testid={categoryVisibility.showData
                    ? `budget-year-actual-${column.year}:${block.direction}:${category}`
                    : undefined}
                  onClick={categoryVisibility.showData
                    ? () => openDrillDown(buildCategoryYearDrillDownFilter(column.year, block.direction, category))
                    : undefined}
                >
                  {categoryVisibility.showData ? formatAmount(yearCell.actual, numberFormat) : MASKED_CELL_PLACEHOLDER}
                </td>
              </Fragment>
            );
          },
          renderPastMonth: () => {
            if (column.kind !== "month") {
              return renderYearLoading("invalid", false);
            }
            const cell = lookupCell(block.cells, column.month, category);
            const isTainted = taintedCells.has(`${block.direction}::${column.month}::${category}`);
            const taintedClass = categoryVisibility.showData && isTainted
              ? ` ${tableStateStyles.warning}`
              : "";
            return (
              <td
                key={column.month}
                className={`${styles.cell}${monthDividerClass}${categoryVisibility.maskClass}${taintedClass}${categoryVisibility.showData ? ` ${styles.cellClickable}` : ""}`}
                title={unconvertibleTitle(isTainted, (month) => month === column.month)}
                onClick={categoryVisibility.showData
                  ? () => openDrillDown(buildCategoryMonthDrillDownFilter(column.month, block.direction, category))
                  : undefined}
              >
                {categoryVisibility.showData ? formatAmount(cell.actual, numberFormat) : MASKED_CELL_PLACEHOLDER}
              </td>
            );
          },
          renderFutureMonth: () => {
            if (column.kind !== "month") {
              return renderYearLoading("invalid", false);
            }
            const cell = lookupCell(block.cells, column.month, category);
            return (
              <BudgetPlanCell
                key={`${column.month}-plan`}
                month={column.month}
                direction={block.direction}
                category={category}
                directionCategories={directionCategories}
                effectiveAllowlist={effectiveAllowlist}
                plannedBase={cell.plannedBase}
                localBaseAcknowledgement={localBaseAcknowledgementByCell.get(
                  getBudgetBaseCellKey({
                    month: column.month,
                    direction: block.direction,
                    category,
                  }),
                ) ?? null}
                plannedModifier={cell.plannedModifier}
                planned={cell.planned}
                showData={categoryVisibility.showData}
                maskClass={categoryVisibility.maskClass}
                isPlanOver={false}
                cmClass=""
                monthDividerClass={monthDividerClass}
                canFillRestOfYear={isBudgetFillSourceMonth(column.month, currentMonth)}
                budgetAdjustments={budgetAdjustments}
                onPlanSave={onPlanSave}
                onBaseMutationIssued={onBaseMutationIssued}
                onFillMonths={onFillMonths}
                onBaseAcknowledged={onBaseAcknowledged}
                onFillMonthsAcknowledged={onFillMonthsAcknowledged}
                onSyncStart={onSyncStart}
                onSyncEnd={onSyncEnd}
              />
            );
          },
          renderSplitMonth: (isCurrentMonth) => {
            if (column.kind !== "month") {
              return renderYearLoading("invalid", false);
            }
            const cell = lookupCell(block.cells, column.month, category);
            const isTainted = taintedCells.has(`${block.direction}::${column.month}::${category}`);
            const taintedClass = isTainted ? ` ${tableStateStyles.warning}` : "";
            const isActualOver = isDirectionActualOverPlanned(block.direction, cell.planned, cell.actual);
            return (
              <Fragment key={column.month}>
                <BudgetPlanCell
                  month={column.month}
                  direction={block.direction}
                  category={category}
                  directionCategories={directionCategories}
                  effectiveAllowlist={effectiveAllowlist}
                  plannedBase={cell.plannedBase}
                  localBaseAcknowledgement={localBaseAcknowledgementByCell.get(
                    getBudgetBaseCellKey({
                      month: column.month,
                      direction: block.direction,
                      category,
                    }),
                  ) ?? null}
                  plannedModifier={cell.plannedModifier}
                  planned={cell.planned}
                  showData={categoryVisibility.showData}
                  maskClass={categoryVisibility.maskClass}
                  isPlanOver={false}
                  cmClass={isCurrentMonth ? ` ${styles.currentMonthPlan}` : ""}
                  monthDividerClass={monthDividerClass}
                  canFillRestOfYear={isBudgetFillSourceMonth(column.month, currentMonth)}
                  budgetAdjustments={budgetAdjustments}
                  onPlanSave={onPlanSave}
                  onBaseMutationIssued={onBaseMutationIssued}
                  onFillMonths={onFillMonths}
                  onBaseAcknowledged={onBaseAcknowledged}
                  onFillMonthsAcknowledged={onFillMonthsAcknowledged}
                  onSyncStart={onSyncStart}
                  onSyncEnd={onSyncEnd}
                />
                <td
                  className={`${styles.cell}${isCurrentMonth ? ` ${styles.currentMonthActual}` : ""}${categoryVisibility.maskClass}${categoryVisibility.showData ? taintedClass : ""}${categoryVisibility.showData && isActualOver ? ` ${tableStateStyles.over}` : ""}${categoryVisibility.showData ? ` ${styles.cellClickable}` : ""}`}
                  title={unconvertibleTitle(isTainted, (month) => month === column.month)}
                  data-testid={categoryVisibility.showData
                    ? `budget-actual-${column.month}:${block.direction}:${category}`
                    : undefined}
                  onClick={categoryVisibility.showData
                    ? () => openDrillDown(buildCategoryMonthDrillDownFilter(column.month, block.direction, category))
                    : undefined}
                >
                  {categoryVisibility.showData ? formatAmount(cell.actual, numberFormat) : MASKED_CELL_PLACEHOLDER}
                </td>
              </Fragment>
            );
          },
        });
      })}
    </tr>
  );
};
