"use client";

import { Fragment, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { CellVisibility } from "@/lib/dataMask";
import type { NumberFormat } from "@/lib/locale";
import {
  formatAmount,
  zeroCellValue,
  type CellValue,
  type ColumnEntry,
  type DirectionBlock,
  type YearTotalComputed,
} from "@/ui/tables/budget/budgetTableLogic";
import styles from "@/ui/tables/budget/BudgetTable.module.css";
import type { DrillDownFilter } from "@/ui/tables/shared/drillDownFilter";
import {
  buildDirectionMonthDrillDownFilter,
  buildDirectionYearDrillDownFilter,
  buildYearTotalStateClass,
  isDirectionActualOverPlanned,
  renderColumnCells,
  renderDerivedYearLoadingCells,
  renderSubtotalYearLoadingCells,
  renderValueCells,
} from "../shared";

type DirectionSubtotalRowProps = Readonly<{
  block: DirectionBlock;
  columnSequence: ReadonlyArray<ColumnEntry>;
  currentMonth: string;
  currentYear: string;
  yearComputed: ReadonlyMap<string, YearTotalComputed>;
  filteredSubtotalsMap: ReadonlyMap<string, ReadonlyMap<string, CellValue>>;
  taintedDirectionMonths: ReadonlySet<string>;
  numberFormat: NumberFormat;
  useFilteredSubtotals: boolean;
  allowedCategoriesArray: ReadonlyArray<string> | null;
  openDrillDown: (filter: DrillDownFilter) => void;
}>;

export const DirectionSubtotalRow = (props: DirectionSubtotalRowProps): ReactElement => {
  const {
    block,
    columnSequence,
    currentMonth,
    currentYear,
    yearComputed,
    filteredSubtotalsMap,
    taintedDirectionMonths,
    numberFormat,
    useFilteredSubtotals,
    allowedCategoriesArray,
    openDrillDown,
  } = props;
  const { t } = useTranslation();
  const dirVis: CellVisibility = { showData: true, maskClass: "" };
  const isTransfer = block.direction === "transfer";
  const labelClass = isTransfer ? styles.categoryLabel : styles.directionLabel;
  const subtotalClass = isTransfer ? "" : ` ${styles.cellSubtotal}`;
  const renderYearLoading = isTransfer ? renderDerivedYearLoadingCells : renderSubtotalYearLoadingCells;

  return (
    <tr className={styles.directionRow}>
      <td className={`${labelClass} ${styles.stickyCol}`}>
        {t(`budget.direction${block.direction.charAt(0).toUpperCase()}${block.direction.slice(1)}`)}
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
            renderYearLoading(column.kind === "year-total" ? column.year : "", isCurrentYearValue),
          renderPastYear: () => {
            if (column.kind !== "year-total" || yearData === undefined) {
              return renderYearLoading(column.kind === "year-total" ? column.year : "", false);
            }
            const yearSubtotal = useFilteredSubtotals
              ? (yearData.filteredSubtotals.get(block.direction) ?? zeroCellValue)
              : (yearData.directionSubtotals.get(block.direction) ?? zeroCellValue);
            const yearTotalStateClass = buildYearTotalStateClass(yearData.taintedDirections.has(block.direction), false);
            return (
              <td
                key={`total-${column.year}`}
                className={`${styles.cell}${subtotalClass} ${styles.yearTotal}${dirVis.maskClass}${yearTotalStateClass}${dirVis.showData ? ` ${styles.cellClickable}` : ""}`}
                onClick={dirVis.showData
                  ? () => openDrillDown(buildDirectionYearDrillDownFilter(column.year, block.direction, allowedCategoriesArray))
                  : undefined}
              >
                {formatAmount(yearSubtotal.actual, numberFormat)}
              </td>
            );
          },
          renderFutureYear: () => {
            if (column.kind !== "year-total" || yearData === undefined) {
              return renderYearLoading(column.kind === "year-total" ? column.year : "", false);
            }
            const yearSubtotal = useFilteredSubtotals
              ? (yearData.filteredSubtotals.get(block.direction) ?? zeroCellValue)
              : (yearData.directionSubtotals.get(block.direction) ?? zeroCellValue);
            const yearTotalStateClass = buildYearTotalStateClass(yearData.taintedDirections.has(block.direction), false);
            return (
              <td key={`total-${column.year}`} className={`${styles.cell}${subtotalClass} ${styles.yearTotal}${dirVis.maskClass}${yearTotalStateClass}`}>
                {formatAmount(yearSubtotal.planned, numberFormat)}
              </td>
            );
          },
          renderCurrentYear: () => {
            if (column.kind !== "year-total" || yearData === undefined) {
              return renderYearLoading(column.kind === "year-total" ? column.year : "", true);
            }
            const yearSubtotal = useFilteredSubtotals
              ? (yearData.filteredSubtotals.get(block.direction) ?? zeroCellValue)
              : (yearData.directionSubtotals.get(block.direction) ?? zeroCellValue);
            const isActualOver = isDirectionActualOverPlanned(block.direction, yearSubtotal.planned, yearSubtotal.actual);
            const yearTotalPlanStateClass = buildYearTotalStateClass(yearData.taintedDirections.has(block.direction), false);
            const yearTotalActualStateClass = buildYearTotalStateClass(yearData.taintedDirections.has(block.direction), isActualOver);
            return (
              <Fragment key={`total-${column.year}`}>
                <td className={`${styles.cell}${subtotalClass} ${styles.yearTotal}${dirVis.maskClass}${yearTotalPlanStateClass}`}>
                  {formatAmount(yearSubtotal.planned, numberFormat)}
                </td>
                <td
                  className={`${styles.cell}${subtotalClass} ${styles.yearTotal}${dirVis.maskClass}${yearTotalActualStateClass}${dirVis.showData ? ` ${styles.cellClickable}` : ""}`}
                  onClick={dirVis.showData
                    ? () => openDrillDown(buildDirectionYearDrillDownFilter(column.year, block.direction, allowedCategoriesArray))
                    : undefined}
                >
                  {formatAmount(yearSubtotal.actual, numberFormat)}
                </td>
              </Fragment>
            );
          },
          renderPastMonth: () => {
            if (column.kind !== "month") {
              return renderYearLoading("invalid", false);
            }
            const subtotal = (useFilteredSubtotals
              ? filteredSubtotalsMap.get(block.direction)?.get(column.month)
              : block.subtotals.get(column.month)) ?? zeroCellValue;
            const isTainted = taintedDirectionMonths.has(`${block.direction}::${column.month}`);
            return renderValueCells({
              key: column.month,
              month: column.month,
              currentMonth,
              planned: subtotal.planned,
              actual: subtotal.actual,
              isTainted,
              isPlanOver: false,
              isActualOver: false,
              isSubtotal: !isTransfer,
              maskClass: dirVis.maskClass,
              plannedValueClass: "",
              actualValueClass: "",
              numberFormat,
              formatter: formatAmount,
              onActualClick: dirVis.showData
                ? () => openDrillDown(buildDirectionMonthDrillDownFilter(column.month, block.direction, allowedCategoriesArray))
                : null,
            });
          },
          renderFutureMonth: () => {
            if (column.kind !== "month") {
              return renderYearLoading("invalid", false);
            }
            const subtotal = (useFilteredSubtotals
              ? filteredSubtotalsMap.get(block.direction)?.get(column.month)
              : block.subtotals.get(column.month)) ?? zeroCellValue;
            const isTainted = taintedDirectionMonths.has(`${block.direction}::${column.month}`);
            return renderValueCells({
              key: column.month,
              month: column.month,
              currentMonth,
              planned: subtotal.planned,
              actual: subtotal.actual,
              isTainted,
              isPlanOver: false,
              isActualOver: false,
              isSubtotal: !isTransfer,
              maskClass: dirVis.maskClass,
              plannedValueClass: "",
              actualValueClass: "",
              numberFormat,
              formatter: formatAmount,
              onActualClick: null,
            });
          },
          renderCurrentMonth: () => {
            if (column.kind !== "month") {
              return renderYearLoading("invalid", false);
            }
            const subtotal = (useFilteredSubtotals
              ? filteredSubtotalsMap.get(block.direction)?.get(column.month)
              : block.subtotals.get(column.month)) ?? zeroCellValue;
            const isTainted = taintedDirectionMonths.has(`${block.direction}::${column.month}`);
            return renderValueCells({
              key: column.month,
              month: column.month,
              currentMonth,
              planned: subtotal.planned,
              actual: subtotal.actual,
              isTainted,
              isPlanOver: false,
              isActualOver: isDirectionActualOverPlanned(block.direction, subtotal.planned, subtotal.actual),
              isSubtotal: !isTransfer,
              maskClass: dirVis.maskClass,
              plannedValueClass: "",
              actualValueClass: "",
              numberFormat,
              formatter: formatAmount,
              onActualClick: dirVis.showData
                ? () => openDrillDown(buildDirectionMonthDrillDownFilter(column.month, block.direction, allowedCategoriesArray))
                : null,
            });
          },
        });
      })}
    </tr>
  );
};
