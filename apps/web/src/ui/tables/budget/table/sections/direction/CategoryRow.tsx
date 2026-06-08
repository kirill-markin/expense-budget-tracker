"use client";

import { Fragment, type ReactElement } from "react";

import { getCellVisibility } from "@/lib/dataMask";
import type { NumberFormat } from "@/lib/locale";
import { BudgetPlanCell } from "@/ui/tables/budget/BudgetPlanCell";
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
} from "../shared";

type CategoryRowProps = Readonly<{
  block: DirectionBlock;
  category: string;
  effectiveAllowlist: ReadonlySet<string> | null;
  columnSequence: ReadonlyArray<ColumnEntry>;
  currentMonth: string;
  currentYear: string;
  yearComputed: ReadonlyMap<string, YearTotalComputed>;
  taintedCells: ReadonlySet<string>;
  commentedCells: ReadonlySet<string>;
  numberFormat: NumberFormat;
  copyToClipboard: (value: string) => void;
  openDrillDown: (filter: DrillDownFilter) => void;
  onPlanSave: (
    month: string,
    direction: string,
    category: string,
    kind: "base" | "modifier",
    value: number,
  ) => void;
  onFillMonths: (
    sourceMonth: string,
    direction: string,
    category: string,
    baseValue: number,
  ) => void;
  onCommentPresenceChange: (
    month: string,
    direction: string,
    category: string,
    hasComment: boolean,
  ) => void;
  onSyncStart: () => void;
  onSyncEnd: () => void;
}>;

export const CategoryRow = (props: CategoryRowProps): ReactElement => {
  const {
    block,
    category,
    effectiveAllowlist,
    columnSequence,
    currentMonth,
    currentYear,
    yearComputed,
    taintedCells,
    commentedCells,
    numberFormat,
    copyToClipboard,
    openDrillDown,
    onPlanSave,
    onFillMonths,
    onCommentPresenceChange,
    onSyncStart,
    onSyncEnd,
  } = props;
  const categoryVisibility = getCellVisibility(effectiveAllowlist, category);

  return (
    <tr key={category} className={styles.categoryRow}>
      <td
        className={`${styles.categoryLabel} ${styles.stickyCol} copyable-cell${categoryVisibility.maskClass}`}
        onClick={() => copyToClipboard(category)}
      >
        {category}
      </td>
      <td className={styles.leftSpacer} />
      {columnSequence.map((column) => {
        const yearData = column.kind === "year-total" ? yearComputed.get(column.year) : undefined;
        return renderColumnCells({
          column,
          currentMonth,
          currentYear,
          isYearLoading: column.kind === "year-total" && yearData === undefined,
          renderYearLoading: (isCurrentYearValue) =>
            renderDerivedYearLoadingCells(column.kind === "year-total" ? column.year : "", isCurrentYearValue),
          renderPastYear: () => {
            if (column.kind !== "year-total" || yearData === undefined) {
              return renderDerivedYearLoadingCells(column.kind === "year-total" ? column.year : "", false);
            }
            const yearCell =
              yearData.directionCategoryTotals.get(block.direction)?.get(category) ?? zeroCellValue;
            const yearTotalStateClass = buildYearTotalStateClass(yearData.taintedCategories.has(`${block.direction}::${category}`), false);
            return (
              <td
                key={`total-${column.year}`}
                className={`${styles.cell} ${styles.yearTotal}${categoryVisibility.maskClass}${yearTotalStateClass}${categoryVisibility.showData ? ` ${styles.cellClickable}` : ""}`}
                onClick={categoryVisibility.showData
                  ? () => openDrillDown(buildCategoryYearDrillDownFilter(column.year, block.direction, category))
                  : undefined}
              >
                {formatAmount(yearCell.actual, numberFormat)}
              </td>
            );
          },
          renderFutureYear: () => {
            if (column.kind !== "year-total" || yearData === undefined) {
              return renderDerivedYearLoadingCells(column.kind === "year-total" ? column.year : "", false);
            }
            const yearCell =
              yearData.directionCategoryTotals.get(block.direction)?.get(category) ?? zeroCellValue;
            const yearTotalStateClass = buildYearTotalStateClass(yearData.taintedCategories.has(`${block.direction}::${category}`), false);
            return (
              <td key={`total-${column.year}`} className={`${styles.cell} ${styles.yearTotal}${categoryVisibility.maskClass}${yearTotalStateClass}`}>
                {formatAmount(yearCell.planned, numberFormat)}
              </td>
            );
          },
          renderCurrentYear: () => {
            if (column.kind !== "year-total" || yearData === undefined) {
              return renderDerivedYearLoadingCells(column.kind === "year-total" ? column.year : "", true);
            }
            const yearCell =
              yearData.directionCategoryTotals.get(block.direction)?.get(category) ?? zeroCellValue;
            const isActualOver = isDirectionActualOverPlanned(block.direction, yearCell.planned, yearCell.actual);
            const yearTotalPlanStateClass = buildYearTotalStateClass(yearData.taintedCategories.has(`${block.direction}::${category}`), false);
            const yearTotalActualStateClass = buildYearTotalStateClass(yearData.taintedCategories.has(`${block.direction}::${category}`), isActualOver);
            return (
              <Fragment key={`total-${column.year}`}>
                <td className={`${styles.cell} ${styles.yearTotal}${categoryVisibility.maskClass}${yearTotalPlanStateClass}`}>
                  {formatAmount(yearCell.planned, numberFormat)}
                </td>
                <td
                  className={`${styles.cell} ${styles.yearTotal}${categoryVisibility.maskClass}${yearTotalActualStateClass}${categoryVisibility.showData ? ` ${styles.cellClickable}` : ""}`}
                  onClick={categoryVisibility.showData
                    ? () => openDrillDown(buildCategoryYearDrillDownFilter(column.year, block.direction, category))
                    : undefined}
                >
                  {formatAmount(yearCell.actual, numberFormat)}
                </td>
              </Fragment>
            );
          },
          renderPastMonth: () => {
            if (column.kind !== "month") {
              return renderDerivedYearLoadingCells("invalid", false);
            }
            const cell = lookupCell(block.cells, column.month, category);
            const taintedClass = taintedCells.has(`${block.direction}::${column.month}::${category}`)
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
                {formatAmount(cell.actual, numberFormat)}
              </td>
            );
          },
          renderFutureMonth: () => {
            if (column.kind !== "month") {
              return renderDerivedYearLoadingCells("invalid", false);
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
                plannedBase={cell.plannedBase}
                plannedModifier={cell.plannedModifier}
                planned={cell.planned}
                hasComment={commentedCells.has(`${column.month}::${block.direction}::${category}`)}
                showData={categoryVisibility.showData}
                maskClass={categoryVisibility.maskClass}
                taintedClass={taintedClass}
                isPlanOver={false}
                cmClass=""
                onPlanSave={onPlanSave}
                onFillMonths={onFillMonths}
                onCommentPresenceChange={onCommentPresenceChange}
                onSyncStart={onSyncStart}
                onSyncEnd={onSyncEnd}
              />
            );
          },
          renderCurrentMonth: () => {
            if (column.kind !== "month") {
              return renderDerivedYearLoadingCells("invalid", false);
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
                  plannedBase={cell.plannedBase}
                  plannedModifier={cell.plannedModifier}
                  planned={cell.planned}
                  hasComment={commentedCells.has(`${column.month}::${block.direction}::${category}`)}
                  showData={categoryVisibility.showData}
                  maskClass={categoryVisibility.maskClass}
                  taintedClass={taintedClass}
                  isPlanOver={false}
                  cmClass={` ${styles.currentMonthPlan}`}
                  onPlanSave={onPlanSave}
                  onFillMonths={onFillMonths}
                  onCommentPresenceChange={onCommentPresenceChange}
                  onSyncStart={onSyncStart}
                  onSyncEnd={onSyncEnd}
                />
                <td
                  className={`${styles.cell} ${styles.currentMonthActual}${categoryVisibility.maskClass}${taintedClass}${isActualOver ? ` ${tableStateStyles.over}` : ""}${categoryVisibility.showData ? ` ${styles.cellClickable}` : ""}`}
                  onClick={categoryVisibility.showData
                    ? () => openDrillDown(buildCategoryMonthDrillDownFilter(column.month, block.direction, category))
                    : undefined}
                >
                  {formatAmount(cell.actual, numberFormat)}
                </td>
              </Fragment>
            );
          },
        });
      })}
    </tr>
  );
};
