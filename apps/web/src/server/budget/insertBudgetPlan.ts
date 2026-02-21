/**
 * Append a budget plan line.
 *
 * Budget lines are append-only: each insert creates a new row with the current
 * timestamp. Queries resolve the effective value via last-write-wins on inserted_at.
 * Currency is set from workspace_settings.reporting_currency at write time.
 */
import { queryAs } from "@/server/db";
import { getReportCurrency } from "@/server/reportCurrency";

type BudgetLineKind = "base" | "modifier";

type InsertBudgetPlanParams = Readonly<{
  month: string;
  direction: string;
  category: string;
  kind: BudgetLineKind;
  plannedValue: number;
}>;

export type { BudgetLineKind, InsertBudgetPlanParams };

export const insertBudgetPlan = async (userId: string, params: InsertBudgetPlanParams): Promise<void> => {
  const reportCurrency = await getReportCurrency(userId);
  await queryAs(
    userId,
    `INSERT INTO budget_lines (user_id, budget_month, direction, category, kind, currency, planned_value)
     VALUES ($1, to_date($2, 'YYYY-MM'), $3, $4, $5, $6, $7)`,
    [userId, params.month, params.direction, params.category, params.kind, reportCurrency, params.plannedValue],
  );
};
