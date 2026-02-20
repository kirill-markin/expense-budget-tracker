import { query } from "@/server/db";
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

export const insertBudgetPlan = async (params: InsertBudgetPlanParams): Promise<void> => {
  const reportCurrency = await getReportCurrency();
  await query(
    `INSERT INTO budget_lines (budget_month, direction, category, kind, currency, planned_value)
     VALUES (to_date($1, 'YYYY-MM'), $2, $3, $4, $5, $6)`,
    [params.month, params.direction, params.category, params.kind, reportCurrency, params.plannedValue],
  );
};
