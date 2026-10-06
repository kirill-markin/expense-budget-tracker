"use client";

import { Fragment, type CSSProperties, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/cn";
import alertStyles from "@/ui/Alert.module.css";
import controlStyles from "@/ui/Controls.module.css";
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
import { buildBudgetValueColumns } from "@/ui/tables/budget/budgetTableLogic";
import styles from "@/ui/tables/budget/BudgetTable.module.css";

const BUDGET_VALUE_COLUMN_WIDTH_PX = 90;

type BudgetTableGeometryStyle = CSSProperties & Readonly<{
  "--budget-value-column-width": string;
  "--budget-values-inline-size": string;
}>;

export const BudgetTable = (props: BudgetTableProps): ReactElement => {
  const { conversionWarnings, reportingCurrency, hints, refreshToken } = props;
  const { t } = useTranslation();
  const { numberFormat } = useFormat();
  const { toastMessage, copyToClipboard } = useCopyToast();
  const controller = useBudgetTableController(props);
  const valueColumns = buildBudgetValueColumns(
    controller.columnSequence,
    controller.currentMonth,
    controller.plansMode,
  );
  const tableGeometryStyle: BudgetTableGeometryStyle = {
    "--budget-value-column-width": `${BUDGET_VALUE_COLUMN_WIDTH_PX}px`,
    "--budget-values-inline-size": `${valueColumns.length * BUDGET_VALUE_COLUMN_WIDTH_PX}px`,
  };

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
        {/*
          The pressed segment follows the mode on screen, never the requested
          one: until the requested mode's rows land it is only pending, which
          its own treatment says instead of claiming a layout nobody sees.
        */}
        <div
          className={controlStyles.segmented}
          aria-busy={controller.isPlansModeRefreshing}
        >
          <button
            className={cn(
              controlStyles.segment,
              controller.plansMode === "actuals" ? controlStyles.segmentActive : "",
              controller.isPlansModePending && controller.requestedPlansMode === "actuals"
                ? controlStyles.segmentPending
                : "",
            )}
            type="button"
            data-testid="budget-plans-mode-actuals"
            aria-pressed={controller.plansMode === "actuals"}
            disabled={controller.isPlansModeRefreshing}
            onClick={() => controller.setPlansMode("actuals")}
          >
            {t("budget.plansModeActuals")}
          </button>
          <button
            className={cn(
              controlStyles.segment,
              controller.plansMode === "all-plans" ? controlStyles.segmentActive : "",
              controller.isPlansModePending && controller.requestedPlansMode === "all-plans"
                ? controlStyles.segmentPending
                : "",
            )}
            type="button"
            data-testid="budget-plans-mode-all"
            aria-pressed={controller.plansMode === "all-plans"}
            disabled={controller.isPlansModeRefreshing}
            onClick={() => controller.setPlansMode("all-plans")}
          >
            {t("budget.plansModeAll")}
          </button>
        </div>
        {/*
          Outstanding writes and a stuck display mode are independent states,
          so they are siblings in this flex row: a save in flight keeps its
          indicator, which the page's unload guard relies on, whatever the mode
          switcher is doing. A mode that is still on its way is part of the
          same "syncing" signal; one that is stuck is not syncing at all and
          says so next to its retry.
        */}
        {(
          controller.pendingSaves > 0
          || (controller.isPlansModePending && !controller.isPlansModeStuck)
        ) && (
          <span className={styles.syncStatus} data-testid="budget-sync-status">
            {t("common.syncing")}
          </span>
        )}
        {controller.isPlansModeStuck && (
          <span
            className={styles.plansModeStuck}
            role="status"
            data-testid="budget-plans-mode-stuck"
          >
            <span>{t("budget.plansModeNotLoaded")}</span>
            <button
              className={styles.todayButton}
              type="button"
              data-testid="budget-plans-mode-retry"
              onClick={controller.retryPlansModeSwitch}
            >
              {t("budget.plansModeRetry")}
            </button>
          </span>
        )}
      </div>
      <div
        className={styles.scroll}
        data-testid="budget-table-scroll"
        ref={controller.scrollRef}
      >
        <table className={styles.table} style={tableGeometryStyle}>
          <colgroup>
            <col className={styles.categoryColumn} />
            {valueColumns.map((column) => (
              <col key={column.key} className={styles.valueColumn} />
            ))}
          </colgroup>
          <BudgetTableHeader
            columnSequence={controller.columnSequence}
            currentMonth={controller.currentMonth}
            currentYear={controller.currentYear}
            plansMode={controller.plansMode}
          />
          <tbody>
            {controller.blocks.map((section) => (
              <Fragment key={section.block.direction}>
                <BudgetDirectionSection
                  block={section.block}
                  directionCategories={section.directionCategories}
                  effectiveAllowlist={controller.effectiveAllowlist}
                  localBaseAcknowledgementByCell={
                    controller.localBaseAcknowledgementByCell
                  }
                  columnSequence={controller.columnSequence}
                  currentMonth={controller.currentMonth}
                  currentYear={controller.currentYear}
                  plansMode={controller.plansMode}
                  loadedFrom={controller.loadedFrom}
                  loadedTo={controller.loadedTo}
                  yearComputed={controller.yearComputed}
                  filteredSubtotalsMap={controller.filteredSubtotalsMap}
                  taintedDirectionMonths={controller.taintedDirectionMonths}
                  unpairedTransferLegs={controller.unpairedTransferLegs}
                  taintedCells={controller.taintedCells}
                  unconvertibleCurrenciesByMonth={controller.unconvertibleCurrenciesByMonth}
                  numberFormat={numberFormat}
                  budgetAdjustments={controller.budgetAdjustments}
                  copyToClipboard={copyToClipboard}
                  openDrillDown={controller.openDrillDown}
                  onPlanSave={controller.handlePlanSave}
                  onBaseMutationIssued={
                    controller.handleBaseMutationIssued
                  }
                  onFillMonths={controller.handleFillMonths}
                  onBaseAcknowledged={controller.handleBaseAcknowledged}
                  onFillMonthsAcknowledged={
                    controller.handleFillMonthsAcknowledged
                  }
                  onSyncStart={controller.onSyncStart}
                  onSyncEnd={controller.onSyncEnd}
                  onAddCategory={controller.addCategory}
                />
              </Fragment>
            ))}
            <BudgetDerivedSection
              effectiveAllowlist={controller.effectiveAllowlist}
              columnSequence={controller.columnSequence}
              currentMonth={controller.currentMonth}
              currentYear={controller.currentYear}
              plansMode={controller.plansMode}
              loadedFrom={controller.loadedFrom}
              loadedTo={controller.loadedTo}
              yearComputed={controller.yearComputed}
              incomeSubtotals={controller.incomeSubtotals}
              spendSubtotals={controller.spendSubtotals}
              transferSubtotals={controller.transferSubtotals}
              taintedMonths={controller.taintedMonths}
              unconvertibleCurrenciesByMonth={controller.unconvertibleCurrenciesByMonth}
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
