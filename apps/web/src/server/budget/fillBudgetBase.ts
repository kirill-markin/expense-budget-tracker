import { insertBudgetPlan } from "@/server/budget/insertBudgetPlan";

type FillBudgetBaseParams = Readonly<{
  fromMonth: string;
  direction: string;
  category: string;
  baseValue: number;
}>;

export const fillBudgetBase = async (params: FillBudgetBaseParams): Promise<number> => {
  const year = params.fromMonth.substring(0, 4);
  const monthNum = parseInt(params.fromMonth.substring(5, 7), 10);

  const targetMonths: Array<string> = [];
  for (let m = monthNum + 1; m <= 12; m++) {
    targetMonths.push(`${year}-${String(m).padStart(2, "0")}`);
  }

  await Promise.all(
    targetMonths.map((month) =>
      insertBudgetPlan({
        month,
        direction: params.direction,
        category: params.category,
        kind: "base",
        plannedValue: params.baseValue,
      }),
    ),
  );

  return targetMonths.length;
};
