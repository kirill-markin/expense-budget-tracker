/**
 * Fill budget base values for remaining months of the year.
 *
 * Given a starting month (e.g. "2026-03"), saves the same base value
 * for every subsequent month through December of that year. A zero value
 * clears the plan of those months, because zero and "no plan" are the same
 * state. Used by the "fill to year-end" UI action. Returns the number of
 * months filled.
 */
import { saveBudgetPlan } from "@/server/budget/saveBudgetPlan";

type FillBudgetBaseParams = Readonly<{
  fromMonth: string;
  direction: string;
  category: string;
  baseValue: number;
}>;

export const fillBudgetBase = async (userId: string, workspaceId: string, params: FillBudgetBaseParams): Promise<number> => {
  const year = params.fromMonth.substring(0, 4);
  const monthNum = parseInt(params.fromMonth.substring(5, 7), 10);

  const targetMonths: Array<string> = [];
  for (let m = monthNum + 1; m <= 12; m++) {
    targetMonths.push(`${year}-${String(m).padStart(2, "0")}`);
  }

  await Promise.all(
    targetMonths.map((month) =>
      saveBudgetPlan(userId, workspaceId, {
        month,
        direction: params.direction,
        category: params.category,
        plannedValue: params.baseValue,
      }),
    ),
  );

  return targetMonths.length;
};
