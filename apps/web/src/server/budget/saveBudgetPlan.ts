/**
 * Save a budget plan line in place.
 *
 * A plan cell is one row per (workspace, month, direction, category): saving
 * updates the existing row or inserts the first one, and saving zero deletes
 * the row, because zero and "no plan" are the same state and both render as 0.
 * Currency is set from workspace_settings.reporting_currency at write time, so
 * an update overwrites it.
 */
import { withUserContext } from "@/server/db";
import type { QueryFn } from "@/server/db/contextRunner";
import { getReportCurrency } from "@/server/reportCurrency";

type SaveBudgetPlanParams = Readonly<{
  month: string;
  direction: string;
  category: string;
  plannedValue: number;
}>;

export type { SaveBudgetPlanParams };

/** PostgreSQL unique_violation. */
const UNIQUE_VIOLATION_CODE = "23505";

/**
 * The only unique constraint a lost insert race can violate: the index
 * budget_lines_cell_idx created in
 * db/migrations/0078_budget_lines_unique_and_no_zero.sql.
 */
const CELL_UNIQUE_CONSTRAINT = "budget_lines_cell_idx";

/** Keeps the surrounding transaction usable after a lost insert race. */
const INSERT_SAVEPOINT = "budget_plan_insert";

const BUDGET_PLAN_CELL_PREDICATE = `
    workspace_id = $1
    AND budget_month = to_date($2, 'YYYY-MM')
    AND direction = $3
    AND category = $4
`;

export const DELETE_BUDGET_PLAN_QUERY = `
  DELETE FROM budget_lines
  WHERE ${BUDGET_PLAN_CELL_PREDICATE}
`;

export const UPDATE_BUDGET_PLAN_QUERY = `
  UPDATE budget_lines
  SET planned_value = $5, currency = $6
  WHERE ${BUDGET_PLAN_CELL_PREDICATE}
  RETURNING line_id
`;

export const INSERT_BUDGET_PLAN_QUERY = `
  INSERT INTO budget_lines (
    workspace_id,
    budget_month,
    direction,
    category,
    planned_value,
    currency
  )
  VALUES ($1, to_date($2, 'YYYY-MM'), $3, $4, $5, $6)
`;

const budgetPlanCellParams = (
  workspaceId: string,
  params: SaveBudgetPlanParams,
): ReadonlyArray<unknown> => [
  workspaceId,
  params.month,
  params.direction,
  params.category,
];

const describeCell = (params: SaveBudgetPlanParams): string =>
  `${params.month} ${params.direction} ${params.category}`;

/**
 * A lost race for the first row of this cell, and nothing else: node-pg reports
 * the violated constraint, so a budget_lines_pkey collision keeps its own error
 * instead of being retried into a misleading "no row to update" message.
 */
const isCellUniqueViolation = (error: unknown): boolean =>
  typeof error === "object"
  && error !== null
  && "code" in error
  && error.code === UNIQUE_VIOLATION_CODE
  && "constraint" in error
  && error.constraint === CELL_UNIQUE_CONSTRAINT;

/** Updates the cell in place and reports whether it already had a row. */
const updateBudgetPlanRow = async (
  queryFn: QueryFn,
  writeParams: ReadonlyArray<unknown>,
): Promise<boolean> => {
  const updated = await queryFn(UPDATE_BUDGET_PLAN_QUERY, writeParams);
  return updated.rows.length > 0;
};

/**
 * Save one plan cell through a caller-provided transactional query function.
 *
 * Deliberately read-then-write instead of ON CONFLICT: the restricted SQL
 * surface used by agents does not support ON CONFLICT, so this shape stays the
 * one every writer can follow. budget_lines_cell_idx makes the insert of a cell
 * another writer created first raise a unique violation, and that violation
 * aborts the whole transaction, so the insert runs inside a savepoint and the
 * update runs once more against the row that writer committed.
 *
 * reportCurrency is null only for a zero value, which deletes the row and
 * stores no currency.
 */
export const saveBudgetPlanWithQuery = async (
  queryFn: QueryFn,
  workspaceId: string,
  reportCurrency: string | null,
  params: SaveBudgetPlanParams,
): Promise<void> => {
  const cellParams = budgetPlanCellParams(workspaceId, params);

  if (params.plannedValue === 0) {
    await queryFn(DELETE_BUDGET_PLAN_QUERY, cellParams);
    return;
  }

  if (reportCurrency === null) {
    throw new Error(
      `Budget plan save for ${describeCell(params)} needs the workspace reporting currency`,
    );
  }

  const writeParams = [...cellParams, params.plannedValue, reportCurrency];
  if (await updateBudgetPlanRow(queryFn, writeParams)) return;

  await queryFn(`SAVEPOINT ${INSERT_SAVEPOINT}`, []);
  try {
    await queryFn(INSERT_BUDGET_PLAN_QUERY, writeParams);
    await queryFn(`RELEASE SAVEPOINT ${INSERT_SAVEPOINT}`, []);
    return;
  } catch (error: unknown) {
    if (!isCellUniqueViolation(error)) throw error;
    await queryFn(`ROLLBACK TO SAVEPOINT ${INSERT_SAVEPOINT}`, []);
  }

  if (await updateBudgetPlanRow(queryFn, writeParams)) return;
  throw new Error(
    `Budget plan insert for ${describeCell(params)} hit a unique violation, but the cell then had no row to update`,
  );
};

export const saveBudgetPlan = async (
  userId: string,
  workspaceId: string,
  params: SaveBudgetPlanParams,
): Promise<void> => {
  // Clearing a cell deletes its row and stores no currency, so only a value
  // that will be stored pays for the workspace_settings read.
  const reportCurrency = params.plannedValue === 0
    ? null
    : await getReportCurrency(userId, workspaceId);
  await withUserContext(userId, workspaceId, async (queryFn): Promise<void> => {
    await saveBudgetPlanWithQuery(queryFn, workspaceId, reportCurrency, params);
  });
};
