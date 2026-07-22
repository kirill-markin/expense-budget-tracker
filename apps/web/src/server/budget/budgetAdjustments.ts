import { z } from "zod";

import { budgetAdjustmentNoteSchema, categorySchema } from "@/server/api/validation";
import { queryAs, withUserContext } from "@/server/db";
import type { QueryFn } from "@/server/db/contextRunner";

export type BudgetAdjustmentDirection = "income" | "spend";

export type BudgetAdjustment = Readonly<{
  adjustmentId: string;
  month: string;
  direction: BudgetAdjustmentDirection;
  category: string;
  amount: number;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type CreateBudgetAdjustmentParams = Readonly<{
  adjustmentId: string;
  month: string;
  direction: BudgetAdjustmentDirection;
  category: string;
  amount: number;
  note: string | null;
}>;

export type PatchBudgetAdjustmentParams = Readonly<{
  amount?: number;
  note?: string | null;
  month?: string;
  category?: string;
}>;

type BudgetAdjustmentQuery = Readonly<{
  text: string;
  params: ReadonlyArray<unknown>;
}>;

const budgetAdjustmentDbRowSchema = z.object({
  adjustment_id: z.string().min(1).max(200),
  month: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/),
  direction: z.enum(["income", "spend"]),
  category: categorySchema,
  amount: z.number().finite().int(),
  note: budgetAdjustmentNoteSchema,
  created_at: z.date(),
  updated_at: z.date(),
}).strict();

const RETURNING_BUDGET_ADJUSTMENT = `
  adjustment_id,
  to_char(budget_month, 'YYYY-MM') AS month,
  direction,
  category,
  amount::double precision AS amount,
  note,
  created_at,
  updated_at
`;

export const CREATE_BUDGET_ADJUSTMENT_QUERY = `
  INSERT INTO budget_adjustments (
    adjustment_id,
    workspace_id,
    budget_month,
    direction,
    category,
    amount,
    note
  )
  VALUES ($2, $1, to_date($3, 'YYYY-MM'), $4, $5, $6, $7)
  ON CONFLICT (adjustment_id) DO NOTHING
  RETURNING ${RETURNING_BUDGET_ADJUSTMENT}
`;

export const BUDGET_ADJUSTMENT_BY_ID_QUERY = `
  SELECT
    ${RETURNING_BUDGET_ADJUSTMENT}
  FROM budget_adjustments
  WHERE workspace_id = $1
    AND adjustment_id = $2
`;

export const DELETE_BUDGET_ADJUSTMENT_QUERY = `
  DELETE FROM budget_adjustments
  WHERE workspace_id = $1
    AND adjustment_id = $2
  RETURNING ${RETURNING_BUDGET_ADJUSTMENT}
`;

export const BUDGET_ADJUSTMENTS_DETAIL_QUERY = `
  SELECT
    ${RETURNING_BUDGET_ADJUSTMENT}
  FROM budget_adjustments
  WHERE workspace_id = $1
    AND budget_month >= to_date($2, 'YYYY-MM')
    AND budget_month < (to_date($3, 'YYYY-MM') + interval '1 month')::date
  ORDER BY budget_month, direction, category, created_at, adjustment_id
`;

export class BudgetAdjustmentNotFoundError extends Error {
  public constructor(adjustmentId: string) {
    super(`Budget adjustment "${adjustmentId}" was not found`);
    this.name = "BudgetAdjustmentNotFoundError";
  }
}

export class BudgetAdjustmentConflictError extends Error {
  public constructor(adjustmentId: string) {
    super(`Budget adjustment ID "${adjustmentId}" is already in use`);
    this.name = "BudgetAdjustmentConflictError";
  }
}

export const mapBudgetAdjustmentRow = (row: unknown, context: string): BudgetAdjustment => {
  const result = budgetAdjustmentDbRowSchema.safeParse(row);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "row"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid budget adjustment database row from ${context}: ${details}`);
  }

  return {
    adjustmentId: result.data.adjustment_id,
    month: result.data.month,
    direction: result.data.direction,
    category: result.data.category,
    amount: result.data.amount,
    note: result.data.note,
    createdAt: result.data.created_at.toISOString(),
    updatedAt: result.data.updated_at.toISOString(),
  };
};

export const mapBudgetAdjustmentRows = (
  rows: ReadonlyArray<unknown>,
  context: string,
): ReadonlyArray<BudgetAdjustment> =>
  rows.map((row, rowIndex): BudgetAdjustment =>
    mapBudgetAdjustmentRow(row, `${context} row ${rowIndex}`));

export const buildPatchBudgetAdjustmentQuery = (
  workspaceId: string,
  adjustmentId: string,
  params: PatchBudgetAdjustmentParams,
): BudgetAdjustmentQuery => {
  const setClauses: Array<string> = [];
  const queryParams: Array<unknown> = [workspaceId, adjustmentId];

  if (params.amount !== undefined) {
    queryParams.push(params.amount);
    setClauses.push(`amount = $${queryParams.length}`);
  }
  if (params.note !== undefined) {
    queryParams.push(params.note);
    setClauses.push(`note = $${queryParams.length}`);
  }
  if (params.month !== undefined) {
    queryParams.push(params.month);
    setClauses.push(`budget_month = to_date($${queryParams.length}, 'YYYY-MM')`);
  }
  if (params.category !== undefined) {
    queryParams.push(params.category);
    setClauses.push(`category = $${queryParams.length}`);
  }

  if (setClauses.length === 0) {
    throw new Error("Cannot patch budget adjustment without at least one editable field");
  }

  return {
    text: `
      UPDATE budget_adjustments
      SET ${setClauses.join(", ")}
      WHERE workspace_id = $1
        AND adjustment_id = $2
      RETURNING ${RETURNING_BUDGET_ADJUSTMENT}
    `,
    params: queryParams,
  };
};

const mapCreatedAdjustment = (rows: ReadonlyArray<unknown>): BudgetAdjustment => {
  if (rows.length !== 1) {
    throw new Error(`Failed to create budget adjustment: expected one returned row, received ${rows.length}`);
  }
  return mapBudgetAdjustmentRow(rows[0], "create budget adjustment");
};

export const budgetAdjustmentMatchesCreateParams = (
  params: CreateBudgetAdjustmentParams,
  adjustment: BudgetAdjustment,
): boolean => params.adjustmentId === adjustment.adjustmentId
  && params.month === adjustment.month
  && params.direction === adjustment.direction
  && params.category === adjustment.category
  && params.amount === adjustment.amount
  && params.note === adjustment.note;

export const createBudgetAdjustmentWithQuery = async (
  queryFn: QueryFn,
  workspaceId: string,
  params: CreateBudgetAdjustmentParams,
): Promise<BudgetAdjustment> => {
  const inserted = await queryFn(
    CREATE_BUDGET_ADJUSTMENT_QUERY,
    [
      workspaceId,
      params.adjustmentId,
      params.month,
      params.direction,
      params.category,
      params.amount,
      params.note,
    ],
  );
  if (inserted.rows.length > 0) return mapCreatedAdjustment(inserted.rows);

  const existingResult = await queryFn(
    BUDGET_ADJUSTMENT_BY_ID_QUERY,
    [workspaceId, params.adjustmentId],
  );
  if (existingResult.rows.length === 1) {
    const existing = mapBudgetAdjustmentRow(
      existingResult.rows[0],
      "existing budget adjustment after create conflict",
    );
    if (budgetAdjustmentMatchesCreateParams(params, existing)) return existing;
  } else if (existingResult.rows.length > 1) {
    throw new Error(
      `Failed to resolve budget adjustment create conflict for "${params.adjustmentId}": expected at most one visible row, received ${existingResult.rows.length}`,
    );
  }

  throw new BudgetAdjustmentConflictError(params.adjustmentId);
};

const mapExistingAdjustment = (
  rows: ReadonlyArray<unknown>,
  adjustmentId: string,
  operation: string,
): BudgetAdjustment => {
  if (rows.length === 0) {
    throw new BudgetAdjustmentNotFoundError(adjustmentId);
  }
  if (rows.length !== 1) {
    throw new Error(`Failed to ${operation} budget adjustment "${adjustmentId}": expected one returned row, received ${rows.length}`);
  }
  return mapBudgetAdjustmentRow(rows[0], `${operation} budget adjustment`);
};

export const createBudgetAdjustment = async (
  userId: string,
  workspaceId: string,
  params: CreateBudgetAdjustmentParams,
): Promise<BudgetAdjustment> => {
  return withUserContext(
    userId,
    workspaceId,
    async (queryFn): Promise<BudgetAdjustment> =>
      createBudgetAdjustmentWithQuery(queryFn, workspaceId, params),
  );
};

export const patchBudgetAdjustment = async (
  userId: string,
  workspaceId: string,
  adjustmentId: string,
  params: PatchBudgetAdjustmentParams,
): Promise<BudgetAdjustment> => {
  const patchQuery = buildPatchBudgetAdjustmentQuery(workspaceId, adjustmentId, params);
  const result = await queryAs(userId, workspaceId, patchQuery.text, patchQuery.params);
  return mapExistingAdjustment(result.rows, adjustmentId, "patch");
};

export const deleteBudgetAdjustment = async (
  userId: string,
  workspaceId: string,
  adjustmentId: string,
): Promise<BudgetAdjustment> => {
  const result = await queryAs(
    userId,
    workspaceId,
    DELETE_BUDGET_ADJUSTMENT_QUERY,
    [workspaceId, adjustmentId],
  );

  return mapExistingAdjustment(result.rows, adjustmentId, "delete");
};
