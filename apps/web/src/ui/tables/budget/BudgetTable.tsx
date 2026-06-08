"use client";

import { Fragment, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import alertStyles from "@/ui/Alert.module.css";
import { useCopyToast } from "@/ui/hooks/useCopyToast";
import { useFormat } from "@/ui/FormatProvider";
import { FxBreakdownPanel } from "@/ui/tables/fx-breakdown/FxBreakdownPanel";
import { DrillDownPanel } from "@/ui/tables/transactions/DrillDownPanel";
import {
  BudgetDerivedSection,
  BudgetDirectionSection,
  BudgetTableHeader,
} from "@/ui/tables/budget/table";
import {
  type BudgetTableProps,
  useBudgetTableController,
} from "@/ui/tables/budget/controller/useBudgetTableController";
import tableStateStyles from "@/ui/tables/shared/TableStates.module.css";
import styles from "@/ui/tables/budget/BudgetTable.module.css";

export const BudgetTable = (props: BudgetTableProps): ReactElement => {
  const { conversionWarnings, reportingCurrency, hints, refreshToken } = props;
  const { t } = useTranslation();
  const { numberFormat } = useFormat();
  const { toastMessage, copyToClipboard } = useCopyToast();
  const controller = useBudgetTableController(props);

  if (controller.months.length === 0) {
    return <p className={styles.empty}>{t("budget.noData")}</p>;
  }

  const currencyList = conversionWarnings.map((warning) => warning.currency).join(", ");

  return (
    <>
      {conversionWarnings.length > 0 && (
        <div className={alertStyles.alert}>
          <strong>{t("budget.conversionTitle")}</strong>
          <span>
            {t("budget.conversionMessage", {
              currencies: currencyList,
              qualifier: conversionWarnings.length === 1 ? t("budget.conversionSingular") : t("budget.conversionPlural"),
              currency: reportingCurrency,
            })}
          </span>
        </div>
      )}
      <div className={styles.alertBar}>
        <button className={styles.todayButton} type="button" onClick={controller.scrollToCurrentMonth}>
          {t("common.today")}
        </button>
        {controller.pendingSaves > 0 && <span className={styles.syncStatus}>{t("common.syncing")}</span>}
      </div>
      <div className={styles.scroll} ref={controller.scrollRef}>
        <table className={styles.table}>
          <BudgetTableHeader
            columnSequence={controller.columnSequence}
            currentMonth={controller.currentMonth}
            currentYear={controller.currentYear}
            isLoadingLeft={controller.isLoadingLeft}
          />
          <tbody>
            {controller.blocks.map((block) => (
              <Fragment key={block.direction}>
                <BudgetDirectionSection
                  block={block}
                  effectiveAllowlist={controller.effectiveAllowlist}
                  columnSequence={controller.columnSequence}
                  currentMonth={controller.currentMonth}
                  currentYear={controller.currentYear}
                  yearComputed={controller.yearComputed}
                  filteredSubtotalsMap={controller.filteredSubtotalsMap}
                  taintedDirectionMonths={controller.taintedDirectionMonths}
                  taintedCells={controller.taintedCells}
                  commentedCells={controller.commentedCells}
                  numberFormat={numberFormat}
                  copyToClipboard={copyToClipboard}
                  openDrillDown={controller.openDrillDown}
                  onPlanSave={controller.handlePlanSave}
                  onFillMonths={controller.handleFillMonths}
                  onCommentPresenceChange={controller.updateCommentCell}
                  onSyncStart={controller.onSyncStart}
                  onSyncEnd={controller.onSyncEnd}
                />
              </Fragment>
            ))}
            <BudgetDerivedSection
              effectiveAllowlist={controller.effectiveAllowlist}
              columnSequence={controller.columnSequence}
              currentMonth={controller.currentMonth}
              currentYear={controller.currentYear}
              yearComputed={controller.yearComputed}
              incomeSubtotals={controller.incomeSubtotals}
              spendSubtotals={controller.spendSubtotals}
              transferSubtotals={controller.transferSubtotals}
              taintedMonths={controller.taintedMonths}
              fxAdjustments={controller.fxAdjustments}
              businessPersonalTransfers={controller.businessPersonalTransfers}
              hasBusinessAccount={controller.hasBusinessAccount}
              cumulativeBalances={controller.cumulativeBalances}
              hasLiquidityBreakdown={controller.hasLiquidityBreakdown}
              liquidityTiers={controller.liquidityTiers}
              mebByLiq={controller.mebByLiq}
              projectedLiqBalances={controller.projectedLiqBalances}
              numberFormat={numberFormat}
              openDrillDown={controller.openDrillDown}
              openFxBreakdown={controller.openFxBreakdown}
            />
          </tbody>
        </table>
        <div className={tableStateStyles.loadingEdge}>{controller.isLoadingRight ? t("common.loading") : ""}</div>
      </div>
      {toastMessage !== null && <div className="copy-toast">{toastMessage}</div>}
      {controller.drillDownFilter !== null && (
        <DrillDownPanel
          filter={controller.drillDownFilter}
          categories={controller.allCategories}
          hints={hints}
          reportingCurrency={reportingCurrency}
          refreshToken={refreshToken}
          onClose={controller.handleDrillDownClose}
        />
      )}
      {controller.fxBreakdownMonth !== null && (
        <FxBreakdownPanel month={controller.fxBreakdownMonth} reportingCurrency={reportingCurrency} refreshToken={refreshToken} onClose={controller.closeFxBreakdown} />
      )}
    </>
  );
};
