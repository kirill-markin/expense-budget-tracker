"use client";

import { Fragment, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { CellVisibility } from "@/lib/dataMask";
import type { NumberFormat } from "@/lib/locale";
import type { UnpairedTransferLeg } from "@/server/budget/getBudgetGrid";
import {
  formatAmount,
  zeroCellValue,
  type BudgetPlansMode,
  type CellValue,
  type ColumnEntry,
  type DirectionBlock,
  type YearTotalComputed,
} from "@/ui/tables/budget/budgetTableLogic";
import styles from "@/ui/tables/budget/BudgetTable.module.css";
import type { DrillDownFilter } from "@/ui/tables/shared/drillDownFilter";
import {
  buildUnconvertibleCurrenciesTitle,
  buildUnconvertibleMonthsTitle,
} from "@/ui/tables/shared/unconvertibleTitle";
import { buildUnpairedTransferLegsTitle } from "@/ui/tables/shared/unpairedTransferTitle";
import {
  buildDirectionMonthDrillDownFilter,
  buildDirectionYearDrillDownFilter,
  buildMonthDividerClass,
  buildYearTotalStateClass,
  isDirectionActualOverPlanned,
  renderColumnCells,
  renderDerivedYearLoadingCells,
  renderSubtotalYearLoadingCells,
  renderUnloadedMonthCells,
  renderValueCells,
} from "../shared";

const EMPTY_UNPAIRED_LEGS: ReadonlyArray<UnpairedTransferLeg> = [];

type DirectionSubtotalRowProps = Readonly<{
  block: DirectionBlock;
  columnSequence: ReadonlyArray<ColumnEntry>;
  currentMonth: string;
  currentYear: string;
  plansMode: BudgetPlansMode;
  loadedFrom: string;
  loadedTo: string;
  yearComputed: ReadonlyMap<string, YearTotalComputed>;
  filteredSubtotalsMap: ReadonlyMap<string, ReadonlyMap<string, CellValue>>;
  taintedDirectionMonths: ReadonlySet<string>;
  unpairedTransferLegs: Readonly<Record<string, ReadonlyArray<UnpairedTransferLeg>>>;
  unconvertibleCurrenciesByMonth: ReadonlyMap<string, ReadonlyArray<string>>;
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
    plansMode,
    loadedFrom,
    loadedTo,
    yearComputed,
    filteredSubtotalsMap,
    taintedDirectionMonths,
    unpairedTransferLegs,
    unconvertibleCurrenciesByMonth,
    numberFormat,
    useFilteredSubtotals,
    allowedCategoriesArray,
    openDrillDown,
  } = props;
  const { t } = useTranslation();
  const formatUnconvertibleReason = (currencies: string): string =>
    t("common.unconvertibleReason", { currencies });
  const unconvertibleTitle = (
    isTainted: boolean,
    includesMonth: (month: string) => boolean,
  ): string | null => (
    isTainted
      ? buildUnconvertibleMonthsTitle(unconvertibleCurrenciesByMonth, includesMonth, formatUnconvertibleReason)
      : null
  );
  /**
   * Year totals come from their own full-year fetch, so their reason comes from
   * that fetch too: the month map only covers the horizontally loaded range.
   */
  const yearUnconvertibleTitle = (
    isTainted: boolean,
    currencies: ReadonlyArray<string>,
  ): string | undefined => (
    isTainted
      ? (buildUnconvertibleCurrenciesTitle(currencies, formatUnconvertibleReason) ?? undefined)
      : undefined
  );
  const dirVis: CellVisibility = { showData: true, maskClass: "" };
  const isTransfer = block.direction === "transfer";
  const labelClass = isTransfer ? styles.categoryLabel : styles.directionLabel;
  const subtotalClass = isTransfer ? "" : ` ${styles.cellSubtotal}`;
  const renderYearLoading = isTransfer ? renderDerivedYearLoadingCells : renderSubtotalYearLoadingCells;
  /** Only the Transfer row sums transfer legs, so only it can hold unpaired ones. */
  const unpairedLegsOfMonth = (month: string): ReadonlyArray<UnpairedTransferLeg> => (
    isTransfer ? (unpairedTransferLegs[month] ?? EMPTY_UNPAIRED_LEGS) : EMPTY_UNPAIRED_LEGS
  );
  const formatUnpairedLeg = (leg: UnpairedTransferLeg): string =>
    `${leg.date} \u00b7 ${leg.accountId} \u00b7 ${formatAmount(leg.amount, numberFormat)} ${leg.currency}`;
  /**
   * Filtered mode masks the amounts this cell sums, so the per-leg dates,
   * accounts and amounts stay hidden and only the heading explains the colour.
   */
  const unpairedTitle = (month: string): string | null => {
    const legs = unpairedLegsOfMonth(month);
    if (legs.length === 0) {
      return null;
    }
    const heading = t("common.unpairedTransferReason");
    if (useFilteredSubtotals) {
      return heading;
    }
    return buildUnpairedTransferLegsTitle(
      legs,
      heading,
      formatUnpairedLeg,
      (count) => t("common.unpairedTransferMore", { count }),
    );
  };
  /**
   * A month can be both FX-untrusted and hold unpaired legs: one warning colour,
   * the currency sentence first and the legs after it.
   */
  const monthActualTitle = (month: string, isTainted: boolean): string | null => {
    const reasons = [
      unconvertibleTitle(isTainted, (candidate) => candidate === month),
      unpairedTitle(month),
    ].filter((reason): reason is string => reason !== null);

    return reasons.length === 0 ? null : reasons.join("\n");
  };

  return (
    <tr className={styles.directionRow}>
      <td className={`${labelClass} ${styles.stickyCol}`}>
        {t(`budget.direction${block.direction.charAt(0).toUpperCase()}${block.direction.slice(1)}`)}
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
          renderMonthLoading: (month) => renderUnloadedMonthCells(
            month,
            currentMonth,
            `${styles.cell}${subtotalClass}`,
            plansMode,
            monthDividerClass,
          ),
          renderPastYear: () => {
            if (column.kind !== "year-total" || yearData === undefined) {
              return renderYearLoading(column.kind === "year-total" ? column.year : "", false);
            }
            const yearSubtotal = useFilteredSubtotals
              ? (yearData.filteredSubtotals.get(block.direction) ?? zeroCellValue)
              : (yearData.directionSubtotals.get(block.direction) ?? zeroCellValue);
            const isYearTainted = yearData.taintedDirections.has(block.direction);
            const yearCurrencies = yearData.unconvertibleCurrenciesByDirection.get(block.direction) ?? [];
            const yearTotalStateClass = buildYearTotalStateClass(isYearTainted, false);
            return (
              <td
                key={`total-${column.year}`}
                className={`${styles.cell}${subtotalClass} ${styles.yearTotal}${dirVis.maskClass}${yearTotalStateClass}${dirVis.showData ? ` ${styles.cellClickable}` : ""}`}
                title={yearUnconvertibleTitle(isYearTainted, yearCurrencies)}
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
            return (
              <td key={`total-${column.year}`} className={`${styles.cell}${subtotalClass} ${styles.yearTotal}${dirVis.maskClass}`}>
                {formatAmount(yearSubtotal.planned, numberFormat)}
              </td>
            );
          },
          renderSplitYear: () => {
            if (column.kind !== "year-total" || yearData === undefined) {
              return renderYearLoading(column.kind === "year-total" ? column.year : "", true);
            }
            const yearSubtotal = useFilteredSubtotals
              ? (yearData.filteredSubtotals.get(block.direction) ?? zeroCellValue)
              : (yearData.directionSubtotals.get(block.direction) ?? zeroCellValue);
            const isActualOver = isDirectionActualOverPlanned(block.direction, yearSubtotal.planned, yearSubtotal.actual);
            const isYearTainted = yearData.taintedDirections.has(block.direction);
            const yearCurrencies = yearData.unconvertibleCurrenciesByDirection.get(block.direction) ?? [];
            // This year's plan sums the elapsed months' actuals in "actuals"
            // mode, so an unconvertible actual leaves the plan incomplete too.
            const isYearPlanTainted = yearData.planEmbedsActuals && isYearTainted;
            const yearTotalPlanStateClass = buildYearTotalStateClass(isYearPlanTainted, false);
            const yearTotalActualStateClass = buildYearTotalStateClass(isYearTainted, isActualOver);
            return (
              <Fragment key={`total-${column.year}`}>
                <td
                  className={`${styles.cell}${subtotalClass} ${styles.yearTotal}${dirVis.maskClass}${yearTotalPlanStateClass}`}
                  title={yearUnconvertibleTitle(isYearPlanTainted, yearCurrencies)}
                >
                  {formatAmount(yearSubtotal.planned, numberFormat)}
                </td>
                <td
                  className={`${styles.cell}${subtotalClass} ${styles.yearTotal}${dirVis.maskClass}${yearTotalActualStateClass}${dirVis.showData ? ` ${styles.cellClickable}` : ""}`}
                  title={yearUnconvertibleTitle(isYearTainted, yearCurrencies)}
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
            const hasUnpairedLegs = unpairedLegsOfMonth(column.month).length > 0;
            return renderValueCells({
              key: column.month,
              month: column.month,
              currentMonth,
              plansMode,
              planned: subtotal.planned,
              actual: subtotal.actual,
              isPlanTainted: false,
              isActualTainted: isTainted || hasUnpairedLegs,
              planTitle: null,
              actualTitle: monthActualTitle(column.month, isTainted),
              isPlanOver: false,
              isActualOver: false,
              isSubtotal: !isTransfer,
              monthDividerClass,
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
            // A future-dated leg lies outside the actual range the unpaired-leg query covers, so it is never marked.
            return renderValueCells({
              key: column.month,
              month: column.month,
              currentMonth,
              plansMode,
              planned: subtotal.planned,
              actual: subtotal.actual,
              isPlanTainted: false,
              isActualTainted: isTainted,
              planTitle: null,
              actualTitle: unconvertibleTitle(isTainted, (candidate) => candidate === column.month),
              isPlanOver: false,
              isActualOver: false,
              isSubtotal: !isTransfer,
              monthDividerClass,
              maskClass: dirVis.maskClass,
              plannedValueClass: "",
              actualValueClass: "",
              numberFormat,
              formatter: formatAmount,
              onActualClick: null,
            });
          },
          renderSplitMonth: () => {
            if (column.kind !== "month") {
              return renderYearLoading("invalid", false);
            }
            const subtotal = (useFilteredSubtotals
              ? filteredSubtotalsMap.get(block.direction)?.get(column.month)
              : block.subtotals.get(column.month)) ?? zeroCellValue;
            const isTainted = taintedDirectionMonths.has(`${block.direction}::${column.month}`);
            const hasUnpairedLegs = unpairedLegsOfMonth(column.month).length > 0;
            return renderValueCells({
              key: column.month,
              month: column.month,
              currentMonth,
              plansMode,
              planned: subtotal.planned,
              actual: subtotal.actual,
              isPlanTainted: false,
              isActualTainted: isTainted || hasUnpairedLegs,
              planTitle: null,
              actualTitle: monthActualTitle(column.month, isTainted),
              isPlanOver: false,
              isActualOver: isDirectionActualOverPlanned(block.direction, subtotal.planned, subtotal.actual),
              isSubtotal: !isTransfer,
              monthDividerClass,
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
