"use client";

import { Fragment, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { getCellVisibility } from "@/lib/dataMask";
import type { NumberFormat } from "@/lib/locale";
import {
  formatAmount,
  formatFxAmount,
  zeroCellValue,
  type CellValue,
  type ColumnEntry,
  type CumulativeBalance,
  type YearTotalComputed,
} from "./logic";
import styles from "./BudgetTable.module.css";
import {
  isNegativeValueOver,
  renderColumnCells,
  renderDerivedYearLoadingCells,
  renderSubtotalYearLoadingCells,
  renderValueCells,
} from "./shared";

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

type MetricRowProps = Readonly<{
  label: string;
  columnSequence: ReadonlyArray<ColumnEntry>;
  currentMonth: string;
  currentYear: string;
  yearComputed: ReadonlyMap<string, YearTotalComputed>;
  numberFormat: NumberFormat;
  derivedMaskClass: string;
  renderPastYear: (year: string, yearData: YearTotalComputed) => ReactElement;
  renderFutureYear: (year: string, yearData: YearTotalComputed) => ReactElement;
  renderCurrentYear: (year: string, yearData: YearTotalComputed) => ReactElement;
  renderPastMonth: (month: string) => ReactElement;
  renderFutureMonth: (month: string) => ReactElement;
  renderCurrentMonth: (month: string) => ReactElement;
  loadingKind: "subtotal" | "derived";
  rowClassName: string;
}>;

type LiquidityRowProps = Readonly<{
  liquidity: string;
  columnSequence: ReadonlyArray<ColumnEntry>;
  currentMonth: string;
  currentYear: string;
  yearComputed: ReadonlyMap<string, YearTotalComputed>;
  numberFormat: NumberFormat;
  derivedMaskClass: string;
  mebByLiq: Readonly<Record<string, Readonly<Record<string, number>>>>;
  projectedLiqBalances: ReadonlyMap<string, Readonly<Record<string, number>>>;
}>;

const MetricRow = (props: MetricRowProps): ReactElement => {
  const {
    label,
    columnSequence,
    currentMonth,
    currentYear,
    yearComputed,
    rowClassName,
    renderPastYear,
    renderFutureYear,
    renderCurrentYear,
    renderPastMonth,
    renderFutureMonth,
    renderCurrentMonth,
    loadingKind,
  } = props;
  const renderLoading = loadingKind === "subtotal" ? renderSubtotalYearLoadingCells : renderDerivedYearLoadingCells;

  return (
    <tr className={rowClassName}>
      <td className={`${rowClassName === styles.directionRow ? styles.directionLabel : styles.categoryLabel} ${styles.stickyCol}`}>{label}</td>
      <td className={styles.leftSpacer} />
      {columnSequence.map((column) => {
        const yearData = column.kind === "year-total" ? yearComputed.get(column.year) : undefined;
        return renderColumnCells({
          column,
          currentMonth,
          currentYear,
          isYearLoading: column.kind === "year-total" && yearData === undefined,
          renderYearLoading: (isCurrentYearValue) =>
            renderLoading(column.kind === "year-total" ? column.year : "", isCurrentYearValue),
          renderPastYear: () => {
            if (column.kind !== "year-total" || yearData === undefined) {
              return renderLoading(column.kind === "year-total" ? column.year : "", false);
            }
            return renderPastYear(column.year, yearData);
          },
          renderFutureYear: () => {
            if (column.kind !== "year-total" || yearData === undefined) {
              return renderLoading(column.kind === "year-total" ? column.year : "", false);
            }
            return renderFutureYear(column.year, yearData);
          },
          renderCurrentYear: () => {
            if (column.kind !== "year-total" || yearData === undefined) {
              return renderLoading(column.kind === "year-total" ? column.year : "", true);
            }
            return renderCurrentYear(column.year, yearData);
          },
          renderPastMonth: () => {
            if (column.kind !== "month") {
              return renderLoading("invalid", false);
            }
            return renderPastMonth(column.month);
          },
          renderFutureMonth: () => {
            if (column.kind !== "month") {
              return renderLoading("invalid", false);
            }
            return renderFutureMonth(column.month);
          },
          renderCurrentMonth: () => {
            if (column.kind !== "month") {
              return renderLoading("invalid", false);
            }
            return renderCurrentMonth(column.month);
          },
        });
      })}
    </tr>
  );
};

const LiquidityRow = (props: LiquidityRowProps): ReactElement => {
  const {
    liquidity,
    columnSequence,
    currentMonth,
    currentYear,
    yearComputed,
    numberFormat,
    derivedMaskClass,
    mebByLiq,
    projectedLiqBalances,
  } = props;
  const { t } = useTranslation();

  return (
    <tr key={`bal-${liquidity}`} className={styles.categoryRow}>
      <td className={`${styles.categoryLabel} ${styles.stickyCol}${derivedMaskClass}`}>
        {t(`budget.liquidity${liquidity.charAt(0).toUpperCase()}${liquidity.slice(1)}`)}
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
            return (
              <td key={`total-${column.year}`} className={`${styles.cell} ${styles.yearTotal}${derivedMaskClass}`}>
                {formatAmount(yearData.decemberBalancesByLiquidity[liquidity] ?? 0, numberFormat)}
              </td>
            );
          },
          renderFutureYear: () => {
            if (column.kind !== "year-total" || yearData === undefined) {
              return renderDerivedYearLoadingCells(column.kind === "year-total" ? column.year : "", false);
            }
            return (
              <td key={`total-${column.year}`} className={`${styles.cell} ${styles.yearTotal}${derivedMaskClass}`}>
                {formatAmount(yearData.decemberBalancesByLiquidityPlan[liquidity] ?? 0, numberFormat)}
              </td>
            );
          },
          renderCurrentYear: () => {
            if (column.kind !== "year-total" || yearData === undefined) {
              return renderDerivedYearLoadingCells(column.kind === "year-total" ? column.year : "", true);
            }
            return (
              <Fragment key={`total-${column.year}`}>
                <td className={`${styles.cell} ${styles.yearTotal}${derivedMaskClass}`}>
                  {formatAmount(yearData.decemberBalancesByLiquidityPlan[liquidity] ?? 0, numberFormat)}
                </td>
                <td className={`${styles.cell} ${styles.yearTotal}${derivedMaskClass}`}>
                  {formatAmount(yearData.decemberBalancesByLiquidity[liquidity] ?? 0, numberFormat)}
                </td>
              </Fragment>
            );
          },
          renderPastMonth: () => {
            if (column.kind !== "month") {
              return renderDerivedYearLoadingCells("invalid", false);
            }
            return (
              <td key={column.month} className={`${styles.cell}${derivedMaskClass}`}>
                {formatAmount(mebByLiq[column.month]?.[liquidity] ?? 0, numberFormat)}
              </td>
            );
          },
          renderFutureMonth: () => {
            if (column.kind !== "month") {
              return renderDerivedYearLoadingCells("invalid", false);
            }
            return (
              <td key={column.month} className={`${styles.cell}${derivedMaskClass}`}>
                {formatAmount(projectedLiqBalances.get(column.month)?.[liquidity] ?? 0, numberFormat)}
              </td>
            );
          },
          renderCurrentMonth: () => {
            if (column.kind !== "month") {
              return renderDerivedYearLoadingCells("invalid", false);
            }
            return (
              <Fragment key={column.month}>
                <td className={`${styles.cell} ${styles.currentMonthPlan}${derivedMaskClass}`}>
                  {formatAmount(projectedLiqBalances.get(column.month)?.[liquidity] ?? 0, numberFormat)}
                </td>
                <td className={`${styles.cell} ${styles.currentMonthActual}${derivedMaskClass}`}>
                  {formatAmount(mebByLiq[column.month]?.[liquidity] ?? 0, numberFormat)}
                </td>
              </Fragment>
            );
          },
        });
      })}
    </tr>
  );
};

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
        numberFormat={numberFormat}
        derivedMaskClass={derivedMaskClass}
        loadingKind="subtotal"
        rowClassName={styles.directionRow}
        renderPastYear={(year, yearData) => {
          const taintedClass = yearData.anyTainted ? ` ${styles.error}` : "";
          return (
            <td key={`total-${year}`} className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}${taintedClass}${isNegativeValueOver(yearData.remainder.actual) ? ` ${styles.over}` : ""}`}>
              {formatAmount(yearData.remainder.actual, numberFormat)}
            </td>
          );
        }}
        renderFutureYear={(year, yearData) => {
          const taintedClass = yearData.anyTainted ? ` ${styles.error}` : "";
          return (
            <td key={`total-${year}`} className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}${taintedClass}${isNegativeValueOver(yearData.remainder.planned) ? ` ${styles.over}` : ""}`}>
              {formatAmount(yearData.remainder.planned, numberFormat)}
            </td>
          );
        }}
        renderCurrentYear={(year, yearData) => {
          const taintedClass = yearData.anyTainted ? ` ${styles.error}` : "";
          return (
            <Fragment key={`total-${year}`}>
              <td className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}${taintedClass}${isNegativeValueOver(yearData.remainder.planned) ? ` ${styles.over}` : ""}`}>
                {formatAmount(yearData.remainder.planned, numberFormat)}
              </td>
              <td className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}${taintedClass}${isNegativeValueOver(yearData.remainder.actual) ? ` ${styles.over}` : ""}`}>
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
        numberFormat={numberFormat}
        derivedMaskClass={derivedMaskClass}
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
        numberFormat={numberFormat}
        derivedMaskClass={derivedMaskClass}
        loadingKind="subtotal"
        rowClassName={styles.directionRow}
        renderPastYear={(year, yearData) => {
          const taintedClass = yearData.decemberBalance.isTainted ? ` ${styles.error}` : "";
          return (
            <td key={`total-${year}`} className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}${taintedClass}${isNegativeValueOver(yearData.decemberBalance.actual) ? ` ${styles.over}` : ""}`}>
              {formatAmount(yearData.decemberBalance.actual, numberFormat)}
            </td>
          );
        }}
        renderFutureYear={(year, yearData) => {
          const taintedClass = yearData.decemberBalance.isTainted ? ` ${styles.error}` : "";
          return (
            <td key={`total-${year}`} className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}${taintedClass}${isNegativeValueOver(yearData.decemberBalance.plan) ? ` ${styles.over}` : ""}`}>
              {formatAmount(yearData.decemberBalance.plan, numberFormat)}
            </td>
          );
        }}
        renderCurrentYear={(year, yearData) => {
          const taintedClass = yearData.decemberBalance.isTainted ? ` ${styles.error}` : "";
          return (
            <Fragment key={`total-${year}`}>
              <td className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}${taintedClass}${isNegativeValueOver(yearData.decemberBalance.plan) ? ` ${styles.over}` : ""}`}>
                {formatAmount(yearData.decemberBalance.plan, numberFormat)}
              </td>
              <td className={`${styles.cell} ${styles.cellSubtotal} ${styles.yearTotal}${derivedMaskClass}${taintedClass}${isNegativeValueOver(yearData.decemberBalance.actual) ? ` ${styles.over}` : ""}`}>
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
