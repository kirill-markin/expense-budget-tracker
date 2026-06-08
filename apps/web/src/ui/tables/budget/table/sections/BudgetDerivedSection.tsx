"use client";

import { Fragment, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { getCellVisibility } from "@/lib/dataMask";
import type { NumberFormat } from "@/lib/locale";
import {
  formatAmount,
  zeroCellValue,
  type CellValue,
  type ColumnEntry,
  type CumulativeBalance,
  type YearTotalComputed,
} from "@/ui/tables/budget/budgetTableLogic";
import styles from "@/ui/tables/budget/BudgetTable.module.css";
import { formatFxAmount } from "@/ui/tables/fx/format";
import {
  buildYearTotalStateClass,
  isNegativeValueOver,
  renderValueCells,
} from "./shared";
import { LiquidityRow } from "./derived/LiquidityRow";
import { MetricRow } from "./derived/MetricRow";

export type BudgetDerivedSectionProps = Readonly<{
  effectiveAllowlist: ReadonlySet<string> | null;
  columnSequence: ReadonlyArray<ColumnEntry>;
  currentMonth: string;
  currentYear: string;
  yearComputed: ReadonlyMap<string, YearTotalComputed>;
  incomeSubtotals: ReadonlyMap<string, CellValue> | undefined;
  spendSubtotals: ReadonlyMap<string, CellValue> | undefined;
  transferSubtotals: ReadonlyMap<string, CellValue> | undefined;
  taintedMonths: ReadonlySet<string>;
  fxAdjustments: ReadonlyMap<string, number>;
  cumulativeBalances: ReadonlyMap<string, CumulativeBalance>;
  hasLiquidityBreakdown: boolean;
  liquidityTiers: ReadonlyArray<string>;
  mebByLiq: Readonly<Record<string, Readonly<Record<string, number>>>>;
  projectedLiqBalances: ReadonlyMap<string, Readonly<Record<string, number>>>;
  numberFormat: NumberFormat;
  openFxBreakdown: (month: string) => void;
}>;

export const BudgetDerivedSection = (props: BudgetDerivedSectionProps): ReactElement => {
  const {
    effectiveAllowlist,
    columnSequence,
    currentMonth,
    currentYear,
    yearComputed,
    incomeSubtotals,
    spendSubtotals,
    transferSubtotals,
    taintedMonths,
    fxAdjustments,
    cumulativeBalances,
    hasLiquidityBreakdown,
    liquidityTiers,
    mebByLiq,
    projectedLiqBalances,
    numberFormat,
    openFxBreakdown,
  } = props;
  const { t } = useTranslation();
  const derivedMaskClass = getCellVisibility(effectiveAllowlist, null).maskClass;

  return (
    <>
      <MetricRow
        label={t("budget.remainder")}
        columnSequence={columnSequence}
        currentMonth={currentMonth}
        currentYear={currentYear}
        yearComputed={yearComputed}
        loadingKind="subtotal"
        rowClassName={styles.directionRow}
        renderPastYear={(year, yearData) => {
          const yearTotalStateClass = buildYearTotalStateClass(yearData.anyTainted, isNegativeValueOver(yearData.remainder.actual));
          return (
            <td key={`total-${year}`} className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}${yearTotalStateClass}`}>
              {formatAmount(yearData.remainder.actual, numberFormat)}
            </td>
          );
        }}
        renderFutureYear={(year, yearData) => {
          const yearTotalStateClass = buildYearTotalStateClass(yearData.anyTainted, isNegativeValueOver(yearData.remainder.planned));
          return (
            <td key={`total-${year}`} className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}${yearTotalStateClass}`}>
              {formatAmount(yearData.remainder.planned, numberFormat)}
            </td>
          );
        }}
        renderCurrentYear={(year, yearData) => {
          const yearTotalPlanStateClass = buildYearTotalStateClass(yearData.anyTainted, isNegativeValueOver(yearData.remainder.planned));
          const yearTotalActualStateClass = buildYearTotalStateClass(yearData.anyTainted, isNegativeValueOver(yearData.remainder.actual));
          return (
            <Fragment key={`total-${year}`}>
              <td className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}${yearTotalPlanStateClass}`}>
                {formatAmount(yearData.remainder.planned, numberFormat)}
              </td>
              <td className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}${yearTotalActualStateClass}`}>
                {formatAmount(yearData.remainder.actual, numberFormat)}
              </td>
            </Fragment>
          );
        }}
        renderPastMonth={(month) => {
          const income = incomeSubtotals?.get(month) ?? zeroCellValue;
          const spend = spendSubtotals?.get(month) ?? zeroCellValue;
          const transfer = transferSubtotals?.get(month) ?? zeroCellValue;
          return renderValueCells({
            key: month,
            month,
            currentMonth,
            planned: income.planned - spend.planned + transfer.planned,
            actual: income.actual - spend.actual + transfer.actual,
            isTainted: taintedMonths.has(month),
            isPlanOver: false,
            isActualOver: false,
            isSubtotal: true,
            maskClass: derivedMaskClass,
            numberFormat,
            formatter: formatAmount,
            onActualClick: null,
          });
        }}
        renderFutureMonth={(month) => {
          const income = incomeSubtotals?.get(month) ?? zeroCellValue;
          const spend = spendSubtotals?.get(month) ?? zeroCellValue;
          const transfer = transferSubtotals?.get(month) ?? zeroCellValue;
          const remainderPlan = income.planned - spend.planned + transfer.planned;
          return renderValueCells({
            key: month,
            month,
            currentMonth,
            planned: remainderPlan,
            actual: income.actual - spend.actual + transfer.actual,
            isTainted: taintedMonths.has(month),
            isPlanOver: isNegativeValueOver(remainderPlan),
            isActualOver: false,
            isSubtotal: true,
            maskClass: derivedMaskClass,
            numberFormat,
            formatter: formatAmount,
            onActualClick: null,
          });
        }}
        renderCurrentMonth={(month) => {
          const income = incomeSubtotals?.get(month) ?? zeroCellValue;
          const spend = spendSubtotals?.get(month) ?? zeroCellValue;
          const transfer = transferSubtotals?.get(month) ?? zeroCellValue;
          const remainderPlan = income.planned - spend.planned + transfer.planned;
          const remainderActual = income.actual - spend.actual + transfer.actual;
          return renderValueCells({
            key: month,
            month,
            currentMonth,
            planned: remainderPlan,
            actual: remainderActual,
            isTainted: taintedMonths.has(month),
            isPlanOver: isNegativeValueOver(remainderPlan),
            isActualOver: isNegativeValueOver(remainderActual),
            isSubtotal: true,
            maskClass: derivedMaskClass,
            numberFormat,
            formatter: formatAmount,
            onActualClick: null,
          });
        }}
      />

      <MetricRow
        label={t("budget.fxAdjust")}
        columnSequence={columnSequence}
        currentMonth={currentMonth}
        currentYear={currentYear}
        yearComputed={yearComputed}
        loadingKind="subtotal"
        rowClassName={styles.categoryRow}
        renderPastYear={(year, yearData) => (
          <td key={`total-${year}`} className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}`}>
            {formatFxAmount(yearData.yearFxAdjust, numberFormat)}
          </td>
        )}
        renderFutureYear={(year) => (
          <td key={`total-${year}`} className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}`} />
        )}
        renderCurrentYear={(year, yearData) => (
          <Fragment key={`total-${year}`}>
            <td className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}`} />
            <td className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}`}>
              {formatFxAmount(yearData.yearFxAdjust, numberFormat)}
            </td>
          </Fragment>
        )}
        renderPastMonth={(month) => {
          const fx = fxAdjustments.get(month);
          const fxClickable = fx !== undefined;
          return renderValueCells({
            key: month,
            month,
            currentMonth,
            planned: 0,
            actual: fx ?? 0,
            isTainted: false,
            isPlanOver: false,
            isActualOver: false,
            isSubtotal: true,
            maskClass: `${derivedMaskClass}${fxClickable ? ` ${styles.cellClickable}` : ""}`,
            numberFormat,
            formatter: formatFxAmount,
            onActualClick: fxClickable ? () => openFxBreakdown(month) : null,
          });
        }}
        renderFutureMonth={(month) => renderValueCells({
          key: month,
          month,
          currentMonth,
          planned: 0,
          actual: 0,
          isTainted: false,
          isPlanOver: false,
          isActualOver: false,
          isSubtotal: true,
          maskClass: derivedMaskClass,
          numberFormat,
          formatter: formatFxAmount,
          onActualClick: null,
        })}
        renderCurrentMonth={(month) => {
          const fx = fxAdjustments.get(month);
          const fxClickable = fx !== undefined;
          return renderValueCells({
            key: month,
            month,
            currentMonth,
            planned: 0,
            actual: fx ?? 0,
            isTainted: false,
            isPlanOver: false,
            isActualOver: false,
            isSubtotal: true,
            maskClass: derivedMaskClass,
            numberFormat,
            formatter: formatFxAmount,
            onActualClick: fxClickable ? () => openFxBreakdown(month) : null,
          });
        }}
      />

      <MetricRow
        label={t("budget.balance")}
        columnSequence={columnSequence}
        currentMonth={currentMonth}
        currentYear={currentYear}
        yearComputed={yearComputed}
        loadingKind="subtotal"
        rowClassName={styles.directionRow}
        renderPastYear={(year, yearData) => {
          const yearTotalStateClass = buildYearTotalStateClass(yearData.decemberBalance.isTainted, isNegativeValueOver(yearData.decemberBalance.actual));
          return (
            <td key={`total-${year}`} className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}${yearTotalStateClass}`}>
              {formatAmount(yearData.decemberBalance.actual, numberFormat)}
            </td>
          );
        }}
        renderFutureYear={(year, yearData) => {
          const yearTotalStateClass = buildYearTotalStateClass(yearData.decemberBalance.isTainted, isNegativeValueOver(yearData.decemberBalance.plan));
          return (
            <td key={`total-${year}`} className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}${yearTotalStateClass}`}>
              {formatAmount(yearData.decemberBalance.plan, numberFormat)}
            </td>
          );
        }}
        renderCurrentYear={(year, yearData) => {
          const yearTotalPlanStateClass = buildYearTotalStateClass(yearData.decemberBalance.isTainted, isNegativeValueOver(yearData.decemberBalance.plan));
          const yearTotalActualStateClass = buildYearTotalStateClass(yearData.decemberBalance.isTainted, isNegativeValueOver(yearData.decemberBalance.actual));
          return (
            <Fragment key={`total-${year}`}>
              <td className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}${yearTotalPlanStateClass}`}>
                {formatAmount(yearData.decemberBalance.plan, numberFormat)}
              </td>
              <td className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}${yearTotalActualStateClass}`}>
                {formatAmount(yearData.decemberBalance.actual, numberFormat)}
              </td>
            </Fragment>
          );
        }}
        renderPastMonth={(month) => {
          const balance = cumulativeBalances.get(month) as CumulativeBalance;
          return renderValueCells({
            key: month,
            month,
            currentMonth,
            planned: balance.plan,
            actual: balance.actual,
            isTainted: balance.isTainted,
            isPlanOver: false,
            isActualOver: false,
            isSubtotal: true,
            maskClass: derivedMaskClass,
            numberFormat,
            formatter: formatAmount,
            onActualClick: null,
          });
        }}
        renderFutureMonth={(month) => {
          const balance = cumulativeBalances.get(month) as CumulativeBalance;
          return renderValueCells({
            key: month,
            month,
            currentMonth,
            planned: balance.plan,
            actual: balance.actual,
            isTainted: balance.isTainted,
            isPlanOver: isNegativeValueOver(balance.plan),
            isActualOver: false,
            isSubtotal: true,
            maskClass: derivedMaskClass,
            numberFormat,
            formatter: formatAmount,
            onActualClick: null,
          });
        }}
        renderCurrentMonth={(month) => {
          const balance = cumulativeBalances.get(month) as CumulativeBalance;
          return renderValueCells({
            key: month,
            month,
            currentMonth,
            planned: balance.plan,
            actual: balance.actual,
            isTainted: balance.isTainted,
            isPlanOver: isNegativeValueOver(balance.plan),
            isActualOver: isNegativeValueOver(balance.actual),
            isSubtotal: true,
            maskClass: derivedMaskClass,
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
          yearComputed={yearComputed}
          numberFormat={numberFormat}
          derivedMaskClass={derivedMaskClass}
          mebByLiq={mebByLiq}
          projectedLiqBalances={projectedLiqBalances}
        />
      ))}
    </>
  );
};
