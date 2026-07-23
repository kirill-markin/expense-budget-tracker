import type {
  BudgetAdjustmentFlushOutcome,
  BudgetAdjustmentRecoveryOutcome,
  BudgetAdjustmentRowsController,
} from "@/ui/tables/budget/controller/budgetAdjustmentRowsController";

export type { BudgetAdjustmentRecoveryOutcome };

export const isSuccessfulBudgetAdjustmentFlushOutcome = (
  outcome: BudgetAdjustmentFlushOutcome,
): boolean => outcome === "saved"
  || outcome === "unchanged"
  || outcome === "deleted";

export const recoverBudgetAdjustment = async (
  controller: BudgetAdjustmentRowsController,
  adjustmentId: string,
): Promise<BudgetAdjustmentRecoveryOutcome> =>
  controller.recoverRow(adjustmentId);
