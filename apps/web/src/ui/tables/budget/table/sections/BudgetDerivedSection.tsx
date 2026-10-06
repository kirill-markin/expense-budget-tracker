"use client";

import { Fragment, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { getCellVisibility, MASKED_CELL_PLACEHOLDER } from "@/lib/dataMask";
import type { NumberFormat } from "@/lib/locale";
import type { BusinessPersonalTransferCell } from "@/server/budget/getBudgetGrid";
import {
  formatAmount,
  formatSignedAmount,
  zeroCellValue,
  type BudgetPlansMode,
  type CellValue,
  type ColumnEntry,
  type CumulativeBalance,
  type YearTotalComputed,
} from "@/ui/tables/budget/budgetTableLogic";
import styles from "@/ui/tables/budget/BudgetTable.module.css";
import { formatFxAmount } from "@/ui/tables/fx/format";
import {
  buildBusinessPersonalTransferMonthDrillDownFilter,
  buildBusinessPersonalTransferYearDrillDownFilter,
  buildYearTotalStateClass,
  isNegativeValueOver,
  renderValueCells,
} from "./shared";
import { LiquidityRow } from "./derived/LiquidityRow";
import { MetricRow } from "./derived/MetricRow";
import type { DrillDownFilter } from "@/ui/tables/shared/drillDownFilter";
import {
  buildUnconvertibleCurrenciesTitle,
  buildUnconvertibleMonthsTitle,
} from "@/ui/tables/shared/unconvertibleTitle";

const ZERO_BUSINESS_PERSONAL_TRANSFER: BusinessPersonalTransferCell = {
  actual: 0,
  hasUnconvertible: false,
};

/**
 * The business-to-personal transfer row carries its own unconvertible flag but
 * no currency list, so its reason comes from the `transfer` grid rows of the
 * same month window: an unconvertible personal leg taints those rows too.
 */
const TRANSFER_DIRECTION = "transfer";

const getRemainderValueClass = (value: number, isTainted: boolean): string => {
  if (isTainted) return "";
  return Math.round(value) < 0 ? styles.remainderNegative : styles.remainderPositive;
};

const getLoadedCumulativeBalance = (
  cumulativeBalances: ReadonlyMap<string, CumulativeBalance>,
  month: string,
): CumulativeBalance => {
  const balance = cumulativeBalances.get(month);
  if (balance === undefined) {
    throw new RangeError(`Loaded budget month "${month}" is missing its cumulative balance`);
  }
  return balance;
};

export type BudgetDerivedSectionProps = Readonly<{
  effectiveAllowlist: ReadonlySet<string> | null;
  columnSequence: ReadonlyArray<ColumnEntry>;
  currentMonth: string;
  currentYear: string;
  plansMode: BudgetPlansMode;
  loadedFrom: string;
  loadedTo: string;
  yearComputed: ReadonlyMap<string, YearTotalComputed>;
  incomeSubtotals: ReadonlyMap<string, CellValue> | undefined;
  spendSubtotals: ReadonlyMap<string, CellValue> | undefined;
  transferSubtotals: ReadonlyMap<string, CellValue> | undefined;
  taintedMonths: ReadonlySet<string>;
  unconvertibleCurrenciesByMonth: ReadonlyMap<string, ReadonlyArray<string>>;
  fxAdjustments: ReadonlyMap<string, number>;
  businessPersonalTransfers: Readonly<Record<string, BusinessPersonalTransferCell>>;
  hasBusinessAccount: boolean;
  cumulativeBalances: ReadonlyMap<string, CumulativeBalance>;
  hasLiquidityBreakdown: boolean;
  liquidityTiers: ReadonlyArray<string>;
  mebByLiq: Readonly<Record<string, Readonly<Record<string, number>>>>;
  projectedLiqBalances: ReadonlyMap<string, Readonly<Record<string, number>>>;
  numberFormat: NumberFormat;
  openDrillDown: (filter: DrillDownFilter) => void;
  openFxBreakdown: (month: string) => void;
}>;

export const BudgetDerivedSection = (props: BudgetDerivedSectionProps): ReactElement => {
  const {
    effectiveAllowlist,
    columnSequence,
    currentMonth,
    currentYear,
    plansMode,
    loadedFrom,
    loadedTo,
    yearComputed,
    incomeSubtotals,
    spendSubtotals,
    transferSubtotals,
    taintedMonths,
    unconvertibleCurrenciesByMonth,
    fxAdjustments,
    businessPersonalTransfers,
    hasBusinessAccount,
    cumulativeBalances,
    hasLiquidityBreakdown,
    liquidityTiers,
    mebByLiq,
    projectedLiqBalances,
    numberFormat,
    openDrillDown,
    openFxBreakdown,
  } = props;
  const { t } = useTranslation();
  const derivedVisibility = getCellVisibility(effectiveAllowlist, null);
  const derivedMaskClass = derivedVisibility.maskClass;
  const canOpenDerivedDrillDown = derivedVisibility.showData;
  const renderDerivedValue = (formattedValue: string): string => (
    derivedVisibility.showData ? formattedValue : MASKED_CELL_PLACEHOLDER
  );
  const renderDerivedStateClass = (stateClass: string): string => (
    derivedVisibility.showData ? stateClass : ""
  );
  const formatUnconvertibleReason = (currencies: string): string =>
    t("common.unconvertibleReason", { currencies });
  const unconvertibleTitle = (
    isTainted: boolean,
    includesMonth: (month: string) => boolean,
  ): string | null => (
    isTainted && derivedVisibility.showData
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
    isTainted && derivedVisibility.showData
      ? (buildUnconvertibleCurrenciesTitle(currencies, formatUnconvertibleReason) ?? undefined)
      : undefined
  );

  return (
    <>
      <MetricRow
        label={t("budget.fxAdjust")}
        columnSequence={columnSequence}
        currentMonth={currentMonth}
        currentYear={currentYear}
        plansMode={plansMode}
        loadedFrom={loadedFrom}
        loadedTo={loadedTo}
        yearComputed={yearComputed}
        loadingKind="derived"
        showData={derivedVisibility.showData}
        maskClass={derivedMaskClass}
        rowClassName={styles.categoryRow}
        renderPastYear={(year, yearData) => (
          <td key={`total-${year}`} className={`${styles.cell} ${styles.yearTotal}${derivedMaskClass}`}>
            {renderDerivedValue(formatFxAmount(yearData.yearFxAdjust, numberFormat))}
          </td>
        )}
        renderFutureYear={(year) => (
          <td key={`total-${year}`} className={`${styles.cell} ${styles.yearTotal}${derivedMaskClass}`}>
            {derivedVisibility.showData ? null : MASKED_CELL_PLACEHOLDER}
          </td>
        )}
        renderSplitYear={(year, yearData) => (
          <Fragment key={`total-${year}`}>
            <td className={`${styles.cell} ${styles.yearTotal}${derivedMaskClass}`}>
              {derivedVisibility.showData ? null : MASKED_CELL_PLACEHOLDER}
            </td>
            <td className={`${styles.cell} ${styles.yearTotal}${derivedMaskClass}`}>
              {renderDerivedValue(formatFxAmount(yearData.yearFxAdjust, numberFormat))}
            </td>
          </Fragment>
        )}
        renderPastMonth={(month, monthDividerClass) => {
          const fx = fxAdjustments.get(month);
          const fxClickable = canOpenDerivedDrillDown && fx !== undefined;
          return renderValueCells({
            key: month,
            month,
            currentMonth,
            plansMode,
            planned: 0,
            actual: fx ?? 0,
            isPlanTainted: false,
            isActualTainted: false,
            planTitle: null,
            actualTitle: null,
            isPlanOver: false,
            isActualOver: false,
            isSubtotal: false,
            monthDividerClass,
            maskClass: `${derivedMaskClass}${fxClickable ? ` ${styles.cellClickable}` : ""}`,
            plannedValueClass: "",
            actualValueClass: "",
            numberFormat,
            formatter: formatFxAmount,
            onActualClick: fxClickable ? () => openFxBreakdown(month) : null,
          });
        }}
        renderFutureMonth={(month, monthDividerClass) => renderValueCells({
          key: month,
          month,
          currentMonth,
          plansMode,
          planned: 0,
          actual: 0,
          isPlanTainted: false,
          isActualTainted: false,
          planTitle: null,
          actualTitle: null,
          isPlanOver: false,
          isActualOver: false,
          isSubtotal: false,
          monthDividerClass,
          maskClass: derivedMaskClass,
          plannedValueClass: "",
          actualValueClass: "",
          numberFormat,
          formatter: formatFxAmount,
          onActualClick: null,
        })}
        renderSplitMonth={(month, isCurrentMonth, monthDividerClass) => {
          const fx = fxAdjustments.get(month);
          const fxClickable = canOpenDerivedDrillDown && fx !== undefined;
          return renderValueCells({
            key: month,
            month,
            currentMonth,
            plansMode,
            planned: 0,
            actual: fx ?? 0,
            isPlanTainted: false,
            isActualTainted: false,
            planTitle: null,
            actualTitle: null,
            isPlanOver: false,
            isActualOver: false,
            isSubtotal: false,
            monthDividerClass,
            maskClass: derivedMaskClass,
            plannedValueClass: "",
            actualValueClass: "",
            numberFormat,
            formatter: formatFxAmount,
            onActualClick: fxClickable ? () => openFxBreakdown(month) : null,
          });
        }}
      />

      <MetricRow
        label={t("budget.remainder")}
        columnSequence={columnSequence}
        currentMonth={currentMonth}
        currentYear={currentYear}
        plansMode={plansMode}
        loadedFrom={loadedFrom}
        loadedTo={loadedTo}
        yearComputed={yearComputed}
        loadingKind="subtotal"
        showData={derivedVisibility.showData}
        maskClass={derivedMaskClass}
        rowClassName={styles.directionRow}
        renderPastYear={(year, yearData) => {
          const yearTotalStateClass = buildYearTotalStateClass(yearData.anyTainted, isNegativeValueOver(yearData.remainder.actual));
          return (
            <td
              key={`total-${year}`}
              className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}${renderDerivedStateClass(yearTotalStateClass)} ${renderDerivedStateClass(getRemainderValueClass(yearData.remainder.actual, yearData.anyTainted))}`}
              title={yearUnconvertibleTitle(yearData.anyTainted, yearData.unconvertibleCurrencies)}
            >
              {renderDerivedValue(formatSignedAmount(yearData.remainder.actual, numberFormat))}
            </td>
          );
        }}
        renderFutureYear={(year, yearData) => {
          // Resolves to false for every future year; the rule stays in one place.
          const isPlanTainted = yearData.planEmbedsActuals && yearData.anyTainted;
          const yearTotalStateClass = buildYearTotalStateClass(isPlanTainted, isNegativeValueOver(yearData.remainder.planned));
          return (
            <td
              key={`total-${year}`}
              className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}${renderDerivedStateClass(yearTotalStateClass)} ${renderDerivedStateClass(getRemainderValueClass(yearData.remainder.planned, isPlanTainted))}`}
              title={yearUnconvertibleTitle(isPlanTainted, yearData.unconvertibleCurrencies)}
            >
              {renderDerivedValue(formatSignedAmount(yearData.remainder.planned, numberFormat))}
            </td>
          );
        }}
        renderSplitYear={(year, yearData) => {
          // This year's plan sums the elapsed months' actuals in "actuals"
          // mode, so an unconvertible actual leaves the plan incomplete too.
          const isPlanTainted = yearData.planEmbedsActuals && yearData.anyTainted;
          const yearTotalPlanStateClass = buildYearTotalStateClass(isPlanTainted, isNegativeValueOver(yearData.remainder.planned));
          const yearTotalActualStateClass = buildYearTotalStateClass(yearData.anyTainted, isNegativeValueOver(yearData.remainder.actual));
          return (
            <Fragment key={`total-${year}`}>
              <td
                className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}${renderDerivedStateClass(yearTotalPlanStateClass)} ${renderDerivedStateClass(getRemainderValueClass(yearData.remainder.planned, isPlanTainted))}`}
                title={yearUnconvertibleTitle(isPlanTainted, yearData.unconvertibleCurrencies)}
              >
                {renderDerivedValue(formatSignedAmount(yearData.remainder.planned, numberFormat))}
              </td>
              <td
                className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}${renderDerivedStateClass(yearTotalActualStateClass)} ${renderDerivedStateClass(getRemainderValueClass(yearData.remainder.actual, yearData.anyTainted))}`}
                title={yearUnconvertibleTitle(yearData.anyTainted, yearData.unconvertibleCurrencies)}
              >
                {renderDerivedValue(formatSignedAmount(yearData.remainder.actual, numberFormat))}
              </td>
            </Fragment>
          );
        }}
        renderPastMonth={(month, monthDividerClass) => {
          const income = incomeSubtotals?.get(month) ?? zeroCellValue;
          const spend = spendSubtotals?.get(month) ?? zeroCellValue;
          const transfer = transferSubtotals?.get(month) ?? zeroCellValue;
          const remainderPlan = income.planned - spend.planned + transfer.planned;
          const remainderActual = income.actual - spend.actual + transfer.actual;
          const isTainted = taintedMonths.has(month);
          return renderValueCells({
            key: month,
            month,
            currentMonth,
            plansMode,
            planned: remainderPlan,
            actual: remainderActual,
            isPlanTainted: false,
            isActualTainted: isTainted,
            planTitle: null,
            actualTitle: unconvertibleTitle(isTainted, (candidate) => candidate === month),
            isPlanOver: false,
            isActualOver: false,
            isSubtotal: true,
            monthDividerClass,
            maskClass: derivedMaskClass,
            plannedValueClass: getRemainderValueClass(remainderPlan, false),
            actualValueClass: getRemainderValueClass(remainderActual, isTainted),
            numberFormat,
            formatter: formatSignedAmount,
            onActualClick: null,
          });
        }}
        renderFutureMonth={(month, monthDividerClass) => {
          const income = incomeSubtotals?.get(month) ?? zeroCellValue;
          const spend = spendSubtotals?.get(month) ?? zeroCellValue;
          const transfer = transferSubtotals?.get(month) ?? zeroCellValue;
          const remainderPlan = income.planned - spend.planned + transfer.planned;
          const remainderActual = income.actual - spend.actual + transfer.actual;
          const isTainted = taintedMonths.has(month);
          return renderValueCells({
            key: month,
            month,
            currentMonth,
            plansMode,
            planned: remainderPlan,
            actual: remainderActual,
            isPlanTainted: false,
            isActualTainted: isTainted,
            planTitle: null,
            actualTitle: unconvertibleTitle(isTainted, (candidate) => candidate === month),
            isPlanOver: isNegativeValueOver(remainderPlan),
            isActualOver: false,
            isSubtotal: true,
            monthDividerClass,
            maskClass: derivedMaskClass,
            plannedValueClass: getRemainderValueClass(remainderPlan, false),
            actualValueClass: getRemainderValueClass(remainderActual, isTainted),
            numberFormat,
            formatter: formatSignedAmount,
            onActualClick: null,
          });
        }}
        renderSplitMonth={(month, isCurrentMonth, monthDividerClass) => {
          const income = incomeSubtotals?.get(month) ?? zeroCellValue;
          const spend = spendSubtotals?.get(month) ?? zeroCellValue;
          const transfer = transferSubtotals?.get(month) ?? zeroCellValue;
          const remainderPlan = income.planned - spend.planned + transfer.planned;
          const remainderActual = income.actual - spend.actual + transfer.actual;
          const isTainted = taintedMonths.has(month);
          return renderValueCells({
            key: month,
            month,
            currentMonth,
            plansMode,
            planned: remainderPlan,
            actual: remainderActual,
            isPlanTainted: false,
            isActualTainted: isTainted,
            planTitle: null,
            actualTitle: unconvertibleTitle(isTainted, (candidate) => candidate === month),
            isPlanOver: isNegativeValueOver(remainderPlan),
            isActualOver: isNegativeValueOver(remainderActual),
            isSubtotal: true,
            monthDividerClass,
            maskClass: derivedMaskClass,
            plannedValueClass: getRemainderValueClass(remainderPlan, false),
            actualValueClass: getRemainderValueClass(remainderActual, isTainted),
            numberFormat,
            formatter: formatSignedAmount,
            onActualClick: null,
          });
        }}
      />

      <MetricRow
        label={t("budget.balance")}
        columnSequence={columnSequence}
        currentMonth={currentMonth}
        currentYear={currentYear}
        plansMode={plansMode}
        loadedFrom={loadedFrom}
        loadedTo={loadedTo}
        yearComputed={yearComputed}
        loadingKind="subtotal"
        showData={derivedVisibility.showData}
        maskClass={derivedMaskClass}
        rowClassName={styles.directionRow}
        renderPastYear={(year, yearData) => {
          const yearTotalStateClass = buildYearTotalStateClass(yearData.decemberBalance.isTainted, isNegativeValueOver(yearData.decemberBalance.actual));
          return (
            <td
              key={`total-${year}`}
              className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}${renderDerivedStateClass(yearTotalStateClass)}`}
              title={yearUnconvertibleTitle(yearData.decemberBalance.isTainted, yearData.unconvertibleCurrencies)}
            >
              {renderDerivedValue(formatAmount(yearData.decemberBalance.actual, numberFormat))}
            </td>
          );
        }}
        renderFutureYear={(year, yearData) => {
          const yearTotalStateClass = buildYearTotalStateClass(yearData.decemberBalance.isTainted, isNegativeValueOver(yearData.decemberBalance.plan));
          return (
            <td
              key={`total-${year}`}
              className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}${renderDerivedStateClass(yearTotalStateClass)}`}
              title={yearUnconvertibleTitle(yearData.decemberBalance.isTainted, yearData.unconvertibleCurrencies)}
            >
              {renderDerivedValue(formatAmount(yearData.decemberBalance.plan, numberFormat))}
            </td>
          );
        }}
        renderSplitYear={(year, yearData) => {
          const yearTotalPlanStateClass = buildYearTotalStateClass(yearData.decemberBalance.isTainted, isNegativeValueOver(yearData.decemberBalance.plan));
          const yearTotalActualStateClass = buildYearTotalStateClass(yearData.decemberBalance.isTainted, isNegativeValueOver(yearData.decemberBalance.actual));
          return (
            <Fragment key={`total-${year}`}>
              <td
                className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}${renderDerivedStateClass(yearTotalPlanStateClass)}`}
                title={yearUnconvertibleTitle(yearData.decemberBalance.isTainted, yearData.unconvertibleCurrencies)}
              >
                {renderDerivedValue(formatAmount(yearData.decemberBalance.plan, numberFormat))}
              </td>
              <td
                className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}${renderDerivedStateClass(yearTotalActualStateClass)}`}
                title={yearUnconvertibleTitle(yearData.decemberBalance.isTainted, yearData.unconvertibleCurrencies)}
              >
                {renderDerivedValue(formatAmount(yearData.decemberBalance.actual, numberFormat))}
              </td>
            </Fragment>
          );
        }}
        renderPastMonth={(month, monthDividerClass) => {
          const balance = getLoadedCumulativeBalance(cumulativeBalances, month);
          // The Balance plan accumulates actuals, so its reason covers every
          // month up to this one.
          const balanceTitle = unconvertibleTitle(balance.isTainted, (candidate) => candidate <= month);
          return renderValueCells({
            key: month,
            month,
            currentMonth,
            plansMode,
            planned: balance.plan,
            actual: balance.actual,
            isPlanTainted: balance.isTainted,
            isActualTainted: balance.isTainted,
            planTitle: balanceTitle,
            actualTitle: balanceTitle,
            isPlanOver: false,
            isActualOver: false,
            isSubtotal: true,
            monthDividerClass,
            maskClass: derivedMaskClass,
            plannedValueClass: "",
            actualValueClass: "",
            numberFormat,
            formatter: formatAmount,
            onActualClick: null,
          });
        }}
        renderFutureMonth={(month, monthDividerClass) => {
          const balance = getLoadedCumulativeBalance(cumulativeBalances, month);
          const balanceTitle = unconvertibleTitle(balance.isTainted, (candidate) => candidate <= month);
          return renderValueCells({
            key: month,
            month,
            currentMonth,
            plansMode,
            planned: balance.plan,
            actual: balance.actual,
            isPlanTainted: balance.isTainted,
            isActualTainted: balance.isTainted,
            planTitle: balanceTitle,
            actualTitle: balanceTitle,
            isPlanOver: isNegativeValueOver(balance.plan),
            isActualOver: false,
            isSubtotal: true,
            monthDividerClass,
            maskClass: derivedMaskClass,
            plannedValueClass: "",
            actualValueClass: "",
            numberFormat,
            formatter: formatAmount,
            onActualClick: null,
          });
        }}
        renderSplitMonth={(month, isCurrentMonth, monthDividerClass) => {
          const balance = getLoadedCumulativeBalance(cumulativeBalances, month);
          const balanceTitle = unconvertibleTitle(balance.isTainted, (candidate) => candidate <= month);
          return renderValueCells({
            key: month,
            month,
            currentMonth,
            plansMode,
            planned: balance.plan,
            actual: balance.actual,
            isPlanTainted: balance.isTainted,
            isActualTainted: balance.isTainted,
            planTitle: balanceTitle,
            actualTitle: balanceTitle,
            isPlanOver: isNegativeValueOver(balance.plan),
            isActualOver: isNegativeValueOver(balance.actual),
            isSubtotal: true,
            monthDividerClass,
            maskClass: derivedMaskClass,
            plannedValueClass: "",
            actualValueClass: "",
            numberFormat,
            formatter: formatAmount,
            onActualClick: null,
          });
        }}
      />

      {hasLiquidityBreakdown && liquidityTiers.map((liquidity) => (
        <LiquidityRow
          key={liquidity}
          liquidity={liquidity}
          columnSequence={columnSequence}
          currentMonth={currentMonth}
          currentYear={currentYear}
          plansMode={plansMode}
          loadedFrom={loadedFrom}
          loadedTo={loadedTo}
          yearComputed={yearComputed}
          numberFormat={numberFormat}
          showData={derivedVisibility.showData}
          derivedMaskClass={derivedMaskClass}
          mebByLiq={mebByLiq}
          projectedLiqBalances={projectedLiqBalances}
        />
      ))}

      {hasBusinessAccount && (
        <MetricRow
          label={t("budget.businessPersonalTransfer")}
          columnSequence={columnSequence}
          currentMonth={currentMonth}
          currentYear={currentYear}
          plansMode={plansMode}
          loadedFrom={loadedFrom}
          loadedTo={loadedTo}
          yearComputed={yearComputed}
          loadingKind="derived"
          showData={derivedVisibility.showData}
          maskClass={derivedMaskClass}
          rowClassName={`${styles.categoryRow} ${styles.businessPersonalDivider}`}
          renderPastYear={(year, yearData) => {
            const cell = yearData.businessPersonalTransfer;
            const stateClass = buildYearTotalStateClass(cell.hasUnconvertible, false);
            return (
              <td
                key={`total-${year}`}
                className={`${styles.cell} ${styles.yearTotal}${derivedMaskClass}${renderDerivedStateClass(stateClass)}${canOpenDerivedDrillDown ? ` ${styles.cellClickable}` : ""}`}
                title={yearUnconvertibleTitle(cell.hasUnconvertible, yearData.unconvertibleCurrenciesByDirection.get(TRANSFER_DIRECTION) ?? [])}
                onClick={canOpenDerivedDrillDown ? () => openDrillDown(buildBusinessPersonalTransferYearDrillDownFilter(year)) : undefined}
              >
                {renderDerivedValue(formatAmount(cell.actual, numberFormat))}
              </td>
            );
          }}
          renderFutureYear={(year) => (
            <td key={`total-${year}`} className={`${styles.cell} ${styles.yearTotal}${derivedMaskClass}`}>
              {derivedVisibility.showData ? null : MASKED_CELL_PLACEHOLDER}
            </td>
          )}
          renderSplitYear={(year, yearData) => {
            const cell = yearData.businessPersonalTransfer;
            const stateClass = buildYearTotalStateClass(cell.hasUnconvertible, false);
            return (
              <Fragment key={`total-${year}`}>
                <td className={`${styles.cell} ${styles.yearTotal}${derivedMaskClass}`}>
                  {derivedVisibility.showData ? null : MASKED_CELL_PLACEHOLDER}
                </td>
                <td
                  className={`${styles.cell} ${styles.yearTotal}${derivedMaskClass}${renderDerivedStateClass(stateClass)}${canOpenDerivedDrillDown ? ` ${styles.cellClickable}` : ""}`}
                  title={yearUnconvertibleTitle(cell.hasUnconvertible, yearData.unconvertibleCurrenciesByDirection.get(TRANSFER_DIRECTION) ?? [])}
                  onClick={canOpenDerivedDrillDown ? () => openDrillDown(buildBusinessPersonalTransferYearDrillDownFilter(year)) : undefined}
                >
                  {renderDerivedValue(formatAmount(cell.actual, numberFormat))}
                </td>
              </Fragment>
            );
          }}
          renderPastMonth={(month, monthDividerClass) => {
            const cell = businessPersonalTransfers[month] ?? ZERO_BUSINESS_PERSONAL_TRANSFER;
            return renderValueCells({
              key: month,
              month,
              currentMonth,
              plansMode,
              planned: 0,
              actual: cell.actual,
              isPlanTainted: false,
              isActualTainted: cell.hasUnconvertible,
              planTitle: null,
              actualTitle: unconvertibleTitle(cell.hasUnconvertible, (candidate) => candidate === month),
              isPlanOver: false,
              isActualOver: false,
              isSubtotal: false,
              monthDividerClass,
              maskClass: derivedMaskClass,
              plannedValueClass: "",
              actualValueClass: "",
              numberFormat,
              formatter: formatAmount,
              onActualClick: canOpenDerivedDrillDown ? () => openDrillDown(buildBusinessPersonalTransferMonthDrillDownFilter(month)) : null,
            });
          }}
          renderFutureMonth={(month, monthDividerClass) => renderValueCells({
            key: month,
            month,
            currentMonth,
            plansMode,
            planned: 0,
            actual: 0,
            isPlanTainted: false,
            isActualTainted: false,
            planTitle: null,
            actualTitle: null,
            isPlanOver: false,
            isActualOver: false,
            isSubtotal: false,
            monthDividerClass,
            maskClass: derivedMaskClass,
            plannedValueClass: "",
            actualValueClass: "",
            numberFormat,
            formatter: formatAmount,
            onActualClick: null,
          })}
          renderSplitMonth={(month, isCurrentMonth, monthDividerClass) => {
            const cell = businessPersonalTransfers[month] ?? ZERO_BUSINESS_PERSONAL_TRANSFER;
            return renderValueCells({
              key: month,
              month,
              currentMonth,
              plansMode,
              planned: 0,
              actual: cell.actual,
              isPlanTainted: false,
              isActualTainted: cell.hasUnconvertible,
              planTitle: null,
              actualTitle: unconvertibleTitle(cell.hasUnconvertible, (candidate) => candidate === month),
              isPlanOver: false,
              isActualOver: false,
              isSubtotal: false,
              monthDividerClass,
              maskClass: derivedMaskClass,
              plannedValueClass: "",
              actualValueClass: "",
              numberFormat,
              formatter: formatAmount,
              onActualClick: canOpenDerivedDrillDown ? () => openDrillDown(buildBusinessPersonalTransferMonthDrillDownFilter(month)) : null,
            });
          }}
        />
      )}
    </>
  );
};
