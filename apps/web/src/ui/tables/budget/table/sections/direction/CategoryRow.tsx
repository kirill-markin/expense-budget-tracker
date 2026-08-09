"use client";

import { Fragment, type ReactElement } from "react";

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
  lookupCell,
  zeroCellValue,
  type ColumnEntry,
  type DirectionBlock,
  type YearTotalComputed,
} from "@/ui/tables/budget/budgetTableLogic";
import styles from "@/ui/tables/budget/BudgetTable.module.css";
import type { DrillDownFilter } from "@/ui/tables/shared/drillDownFilter";
import tableStateStyles from "@/ui/tables/shared/TableStates.module.css";
import {
  buildCategoryMonthDrillDownFilter,
  buildCategoryYearDrillDownFilter,
  buildYearTotalStateClass,
  isDirectionActualOverPlanned,
  renderColumnCells,
  renderDerivedYearLoadingCells,
  renderMaskedYearCells,
  renderUnloadedMonthCells,
} from "../shared";

type CategoryRowProps = Readonly<{
  block: DirectionBlock;
  category: string;
  effectiveAllowlist: ReadonlySet<string> | null;
  localBaseAcknowledgementByCell: BudgetBaseLocalAcknowledgementByCell;
  columnSequence: ReadonlyArray<ColumnEntry>;
  currentMonth: string;
  currentYear: string;
  loadedFrom: string;
  loadedTo: string;
  yearComputed: ReadonlyMap<string, YearTotalComputed>;
  taintedCells: ReadonlySet<string>;
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
    category,
    effectiveAllowlist,
    localBaseAcknowledgementByCell,
    columnSequence,
    currentMonth,
    currentYear,
    loadedFrom,
    loadedTo,
    yearComputed,
    taintedCells,
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
  const categoryVisibility = getCellVisibility(effectiveAllowlist, category);
  const renderYearLoading = (year: string, isCurrentYearValue: boolean): ReactElement => (
    categoryVisibility.showData
      ? renderDerivedYearLoadingCells(year, isCurrentYearValue)
      : renderMaskedYearCells(year, isCurrentYearValue, categoryVisibility.maskClass)
  );

  return (
    <tr key={category} className={styles.categoryRow}>
      <td
        className={`${styles.categoryLabel} ${styles.stickyCol}${categoryVisibility.showData ? " copyable-cell" : ""}${categoryVisibility.maskClass}`}
        onClick={categoryVisibility.showData ? () => copyToClipboard(category) : undefined}
      >
        {categoryVisibility.showData ? category : MASKED_CELL_PLACEHOLDER}
      </td>
      {columnSequence.map((column) => {
        const yearData = column.kind === "year-total" ? yearComputed.get(column.year) : undefined;
        return renderColumnCells({
          column,
          currentMonth,
          currentYear,
          loadedFrom,
          loadedTo,
          isYearLoading: column.kind === "year-total" && yearData === undefined,
          renderYearLoading: (isCurrentYearValue) =>
            renderYearLoading(column.kind === "year-total" ? column.year : "", isCurrentYearValue),
          renderMonthLoading: (month) =>
            renderUnloadedMonthCells(month, currentMonth, styles.cell),
          renderPastYear: () => {
            if (column.kind !== "year-total" || yearData === undefined) {
              return renderYearLoading(column.kind === "year-total" ? column.year : "", false);
            }
            const yearCell =
              yearData.directionCategoryTotals.get(block.direction)?.get(category) ?? zeroCellValue;
            const yearTotalStateClass = categoryVisibility.showData
              ? buildYearTotalStateClass(yearData.taintedCategories.has(`${block.direction}::${category}`), false)
              : "";
            return (
              <td
                key={`total-${column.year}`}
                className={`${styles.cell} ${styles.yearTotal}${categoryVisibility.maskClass}${yearTotalStateClass}${categoryVisibility.showData ? ` ${styles.cellClickable}` : ""}`}
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
            const yearTotalStateClass = categoryVisibility.showData
              ? buildYearTotalStateClass(yearData.taintedCategories.has(`${block.direction}::${category}`), false)
              : "";
            return (
              <td
                key={`total-${column.year}`}
                className={`${styles.cell} ${styles.yearTotal}${categoryVisibility.maskClass}${yearTotalStateClass}`}
                data-testid={categoryVisibility.showData
                  ? `budget-year-plan-${column.year}:${block.direction}:${category}`
                  : undefined}
              >
                {categoryVisibility.showData ? formatAmount(yearCell.planned, numberFormat) : MASKED_CELL_PLACEHOLDER}
              </td>
            );
          },
          renderCurrentYear: () => {
            if (column.kind !== "year-total" || yearData === undefined) {
              return renderYearLoading(column.kind === "year-total" ? column.year : "", true);
            }
            const yearCell =
              yearData.directionCategoryTotals.get(block.direction)?.get(category) ?? zeroCellValue;
            const isActualOver = isDirectionActualOverPlanned(block.direction, yearCell.planned, yearCell.actual);
            const yearTotalPlanStateClass = categoryVisibility.showData
              ? buildYearTotalStateClass(yearData.taintedCategories.has(`${block.direction}::${category}`), false)
              : "";
            const yearTotalActualStateClass = categoryVisibility.showData
              ? buildYearTotalStateClass(yearData.taintedCategories.has(`${block.direction}::${category}`), isActualOver)
              : "";
            return (
              <Fragment key={`total-${column.year}`}>
                <td
                  className={`${styles.cell} ${styles.yearTotal}${categoryVisibility.maskClass}${yearTotalPlanStateClass}`}
                  data-testid={categoryVisibility.showData
                    ? `budget-year-plan-${column.year}:${block.direction}:${category}`
                    : undefined}
                >
                  {categoryVisibility.showData ? formatAmount(yearCell.planned, numberFormat) : MASKED_CELL_PLACEHOLDER}
                </td>
                <td
                  className={`${styles.cell} ${styles.yearTotal}${categoryVisibility.maskClass}${yearTotalActualStateClass}${categoryVisibility.showData ? ` ${styles.cellClickable}` : ""}`}
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
            const taintedClass = categoryVisibility.showData && taintedCells.has(`${block.direction}::${column.month}::${category}`)
              ? ` ${tableStateStyles.error}`
              : "";
            return (
              <td
                key={column.month}
                className={`${styles.cell}${categoryVisibility.maskClass}${taintedClass}${categoryVisibility.showData ? ` ${styles.cellClickable}` : ""}`}
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
            const taintedClass = taintedCells.has(`${block.direction}::${column.month}::${category}`)
              ? ` ${tableStateStyles.error}`
              : "";
            return (
              <BudgetPlanCell
                key={`${column.month}-plan`}
                month={column.month}
                direction={block.direction}
                category={category}
                directionCategories={block.categories}
                effectiveAllowlist={effectiveAllowlist}
                currentMonth={currentMonth}
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
                taintedClass={taintedClass}
                isPlanOver={false}
                cmClass=""
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
          renderCurrentMonth: () => {
            if (column.kind !== "month") {
              return renderYearLoading("invalid", false);
            }
            const cell = lookupCell(block.cells, column.month, category);
            const taintedClass = taintedCells.has(`${block.direction}::${column.month}::${category}`)
              ? ` ${tableStateStyles.error}`
              : "";
            const isActualOver = isDirectionActualOverPlanned(block.direction, cell.planned, cell.actual);
            return (
              <Fragment key={column.month}>
                <BudgetPlanCell
                  month={column.month}
                  direction={block.direction}
                  category={category}
                  directionCategories={block.categories}
                  effectiveAllowlist={effectiveAllowlist}
                  currentMonth={currentMonth}
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
                  taintedClass={taintedClass}
                  isPlanOver={false}
                  cmClass={` ${styles.currentMonthPlan}`}
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
                  className={`${styles.cell} ${styles.currentMonthActual}${categoryVisibility.maskClass}${categoryVisibility.showData ? taintedClass : ""}${categoryVisibility.showData && isActualOver ? ` ${tableStateStyles.over}` : ""}${categoryVisibility.showData ? ` ${styles.cellClickable}` : ""}`}
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
