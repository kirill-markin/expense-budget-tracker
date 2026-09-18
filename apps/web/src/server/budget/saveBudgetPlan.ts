/**
 * Save a budget plan line in place.
 *
 * A plan cell is one row per (workspace, month, direction, category, kind):
 * saving updates the existing row or inserts the first one, and saving zero
 * deletes the row, because zero and "no plan" are the same state and both
 * render as 0. Currency is set from workspace_settings.reporting_currency at
 * write time, so an update overwrites it.
 */
import { withUserContext } from "@/server/db";
import type { QueryFn } from "@/server/db/contextRunner";
import { getReportCurrency } from "@/server/reportCurrency";

type BudgetLineKind = "base";

type SaveBudgetPlanParams = Readonly<{
  month: string;
  direction: string;
  category: string;
  kind: BudgetLineKind;
  plannedValue: number;
}>;

export type { BudgetLineKind, SaveBudgetPlanParams };

const BUDGET_PLAN_CELL_PREDICATE = `
    workspace_id = $1
    AND budget_month = to_date($2, 'YYYY-MM')
    AND direction = $3
    AND category = $4
    AND kind = $5
`;

export const DELETE_BUDGET_PLAN_QUERY = `
  DELETE FROM budget_lines
  WHERE ${BUDGET_PLAN_CELL_PREDICATE}
`;

export const UPDATE_BUDGET_PLAN_QUERY = `
  UPDATE budget_lines
  SET planned_value = $6, currency = $7
  WHERE ${BUDGET_PLAN_CELL_PREDICATE}
`;

export const INSERT_BUDGET_PLAN_QUERY = `
  INSERT INTO budget_lines (
    workspace_id,
    budget_month,
    direction,
    category,
    kind,
    planned_value,
    currency
  )
  VALUES ($1, to_date($2, 'YYYY-MM'), $3, $4, $5, $6, $7)
`;

const budgetPlanCellParams = (
  workspaceId: string,
  params: SaveBudgetPlanParams,
): ReadonlyArray<unknown> => [
  workspaceId,
  params.month,
  params.direction,
  params.category,
  params.kind,
];

/**
 * Save one plan cell through a caller-provided transactional query function.
 *
 * Deliberately read-then-write instead of ON CONFLICT: budget_lines has no
 * unique index yet and the restricted SQL surface used by agents does not
 * support ON CONFLICT, so this shape stays valid for every writer.
 */
export const saveBudgetPlanWithQuery = async (
  queryFn: QueryFn,
  workspaceId: string,
  reportCurrency: string,
  params: SaveBudgetPlanParams,
): Promise<void> => {
  const cellParams = budgetPlanCellParams(workspaceId, params);

  if (params.plannedValue === 0) {
    await queryFn(DELETE_BUDGET_PLAN_QUERY, cellParams);
    return;
  }

  const writeParams = [...cellParams, params.plannedValue, reportCurrency];
  const updated = await queryFn(UPDATE_BUDGET_PLAN_QUERY, writeParams);
  const updatedRows = updated.rowCount;
  if (updatedRows === null) {
    throw new Error(
      `Budget plan update reported no affected row count for ${params.month} ${params.direction} ${params.category}`,
    );
  }
  if (updatedRows > 0) return;

  await queryFn(INSERT_BUDGET_PLAN_QUERY, writeParams);
};

export const saveBudgetPlan = async (
  userId: string,
  workspaceId: string,
  params: SaveBudgetPlanParams,
): Promise<void> => {
  const reportCurrency = await getReportCurrency(userId, workspaceId);
  await withUserContext(userId, workspaceId, async (queryFn): Promise<void> => {
    await saveBudgetPlanWithQuery(queryFn, workspaceId, reportCurrency, params);
  });
};
