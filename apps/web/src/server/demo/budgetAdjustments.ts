import { Buffer } from "node:buffer";

import { z } from "zod";

import { DEMO_BUDGET_ADJUSTMENTS_COOKIE } from "@/lib/demoCookies";
import { ApiRouteError } from "@/server/api/errors";
import { budgetAdjustmentNoteSchema, categorySchema, adjustmentUuidSchema } from "@/server/api/validation";
import { budgetAdjustmentMatchesCreateParams, BudgetAdjustmentConflictError, BudgetAdjustmentNotFoundError, type BudgetAdjustment, type CreateBudgetAdjustmentParams, type PatchBudgetAdjustmentParams } from "@/server/budget/budgetAdjustments";
import { getDemoBudgetAdjustments } from "@/server/demo/data";

const MAX_SESSION_ROWS = 8;
const MAX_SESSION_COOKIE_VALUE_LENGTH = 3000;

const demoBudgetAdjustmentSchema: z.ZodType<BudgetAdjustment> = z.object({
  adjustmentId: z.string().min(1).max(200),
  month: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/),
  direction: z.enum(["income", "spend"]),
  category: categorySchema,
  amount: z.number().safe().int(),
  note: budgetAdjustmentNoteSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

const demoBudgetAdjustmentSessionSchema = z.object({
  rows: z.array(demoBudgetAdjustmentSchema).max(MAX_SESSION_ROWS),
  deletedAdjustmentIds: z.array(z.string().min(1).max(200)).max(MAX_SESSION_ROWS),
}).strict();

export type DemoBudgetAdjustmentSessionState = Readonly<{
  rows: ReadonlyArray<BudgetAdjustment>;
  deletedAdjustmentIds: ReadonlyArray<string>;
}>;

export type DemoBudgetAdjustmentMutation = Readonly<{
  state: DemoBudgetAdjustmentSessionState;
  adjustment: BudgetAdjustment;
}>;

export const EMPTY_DEMO_BUDGET_ADJUSTMENT_SESSION: DemoBudgetAdjustmentSessionState = {
  rows: [],
  deletedAdjustmentIds: [],
};

const compareAdjustments = (left: BudgetAdjustment, right: BudgetAdjustment): number =>
  left.month.localeCompare(right.month)
  || left.direction.localeCompare(right.direction)
  || left.category.localeCompare(right.category)
  || left.createdAt.localeCompare(right.createdAt)
  || left.adjustmentId.localeCompare(right.adjustmentId);

const validateSessionIds = (state: DemoBudgetAdjustmentSessionState): void => {
  const rowIds = new Set<string>();
  for (const row of state.rows) {
    if (rowIds.has(row.adjustmentId)) {
      throw new ApiRouteError(
        400,
        "Invalid demo budget adjustment session: duplicate row ID. Use Reset Demo changes on the error page.",
      );
    }
    rowIds.add(row.adjustmentId);
  }
  const deletedIds = new Set<string>();
  for (const adjustmentId of state.deletedAdjustmentIds) {
    if (deletedIds.has(adjustmentId) || rowIds.has(adjustmentId)) {
      throw new ApiRouteError(
        400,
        "Invalid demo budget adjustment session: conflicting deleted ID. Use Reset Demo changes on the error page.",
      );
    }
    deletedIds.add(adjustmentId);
  }
};

export const parseDemoBudgetAdjustmentSessionCookie = (
  value: string | null,
): DemoBudgetAdjustmentSessionState => {
  if (value === null || value === "") return EMPTY_DEMO_BUDGET_ADJUSTMENT_SESSION;

  let input: unknown;
  try {
    input = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new ApiRouteError(
      400,
      "Invalid demo budget adjustment session cookie. Use Reset Demo changes on the error page.",
    );
  }
  const parsed = demoBudgetAdjustmentSessionSchema.safeParse(input);
  if (!parsed.success) {
    throw new ApiRouteError(
      400,
      "Invalid demo budget adjustment session cookie. Use Reset Demo changes on the error page.",
    );
  }
  const state: DemoBudgetAdjustmentSessionState = {
    rows: parsed.data.rows,
    deletedAdjustmentIds: parsed.data.deletedAdjustmentIds,
  };
  validateSessionIds(state);
  return state;
};

export const readDemoBudgetAdjustmentSession = (
  request: Request,
): DemoBudgetAdjustmentSessionState => {
  const prefix = `${DEMO_BUDGET_ADJUSTMENTS_COOKIE}=`;
  const cookie = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));
  return parseDemoBudgetAdjustmentSessionCookie(
    cookie === undefined ? null : cookie.slice(prefix.length),
  );
};

export const serializeDemoBudgetAdjustmentSessionCookie = (
  state: DemoBudgetAdjustmentSessionState,
): string => {
  if (state.rows.length > MAX_SESSION_ROWS
    || state.deletedAdjustmentIds.length > MAX_SESSION_ROWS) {
    throw new ApiRouteError(
      409,
      `Demo budget adjustment session supports at most ${MAX_SESSION_ROWS} changed rows. Delete an adjustment to free space.`,
    );
  }
  validateSessionIds(state);
  const parsed = demoBudgetAdjustmentSessionSchema.safeParse(state);
  if (!parsed.success) {
    throw new Error(`Cannot serialize invalid demo budget adjustment session: ${parsed.error.message}`);
  }
  if (state.rows.length === 0 && state.deletedAdjustmentIds.length === 0) {
    return `${DEMO_BUDGET_ADJUSTMENTS_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
  }
  const value = Buffer.from(JSON.stringify(parsed.data), "utf8").toString("base64url");
  if (value.length > MAX_SESSION_COOKIE_VALUE_LENGTH) {
    throw new ApiRouteError(
      409,
      "Demo budget adjustment session is full. Shorten notes or delete an adjustment to free space.",
    );
  }
  return `${DEMO_BUDGET_ADJUSTMENTS_COOKIE}=${value}; Path=/; SameSite=Lax`;
};

export const getDemoBudgetAdjustmentsForSession = (
  state: DemoBudgetAdjustmentSessionState,
): ReadonlyArray<BudgetAdjustment> => {
  const deletedIds = new Set(state.deletedAdjustmentIds);
  const byId = new Map(getDemoBudgetAdjustments()
    .filter((adjustment) => !deletedIds.has(adjustment.adjustmentId))
    .map((adjustment): readonly [string, BudgetAdjustment] => [
      adjustment.adjustmentId,
      adjustment,
    ]));
  for (const adjustment of state.rows) byId.set(adjustment.adjustmentId, adjustment);
  return [...byId.values()].sort(compareAdjustments);
};

const replaceSessionRow = (
  state: DemoBudgetAdjustmentSessionState,
  adjustment: BudgetAdjustment,
): DemoBudgetAdjustmentSessionState => ({
  rows: [...state.rows.filter((row) => row.adjustmentId !== adjustment.adjustmentId), adjustment]
    .sort(compareAdjustments),
  deletedAdjustmentIds: state.deletedAdjustmentIds.filter((adjustmentId) =>
    adjustmentId !== adjustment.adjustmentId),
});

const getDeterministicCreateTimestamp = (adjustmentId: string): string => {
  const parsed = adjustmentUuidSchema.safeParse(adjustmentId);
  if (!parsed.success) {
    throw new Error(`Cannot create demo budget adjustment with non-UUID ID "${adjustmentId}"`);
  }
  const secondsAfterEpoch = Number.parseInt(adjustmentId.slice(0, 8), 16);
  return new Date(Date.UTC(2000, 0, 1) + secondsAfterEpoch * 1000).toISOString();
};

export const createDemoBudgetAdjustment = (
  state: DemoBudgetAdjustmentSessionState,
  params: CreateBudgetAdjustmentParams,
): DemoBudgetAdjustmentMutation => {
  const existing = getDemoBudgetAdjustmentsForSession(state).find((adjustment) =>
    adjustment.adjustmentId === params.adjustmentId);
  if (existing !== undefined) {
    if (budgetAdjustmentMatchesCreateParams(params, existing)) {
      return { state, adjustment: existing };
    }
    throw new BudgetAdjustmentConflictError(params.adjustmentId);
  }

  const timestamp = getDeterministicCreateTimestamp(params.adjustmentId);
  const adjustment: BudgetAdjustment = {
    adjustmentId: params.adjustmentId,
    month: params.month,
    direction: params.direction,
    category: params.category,
    amount: params.amount,
    note: params.note,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return { state: replaceSessionRow(state, adjustment), adjustment };
};

export const patchDemoBudgetAdjustment = (
  state: DemoBudgetAdjustmentSessionState,
  adjustmentId: string,
  params: PatchBudgetAdjustmentParams,
  updatedAt: string,
): DemoBudgetAdjustmentMutation => {
  const existing = getDemoBudgetAdjustmentsForSession(state).find((adjustment) =>
    adjustment.adjustmentId === adjustmentId);
  if (existing === undefined) throw new BudgetAdjustmentNotFoundError(adjustmentId);

  const adjustment: BudgetAdjustment = {
    adjustmentId,
    month: params.month ?? existing.month,
    direction: existing.direction,
    category: params.category ?? existing.category,
    amount: params.amount ?? existing.amount,
    note: params.note !== undefined ? params.note : existing.note,
    createdAt: existing.createdAt,
    updatedAt,
  };
  return { state: replaceSessionRow(state, adjustment), adjustment };
};

export const deleteDemoBudgetAdjustment = (
  state: DemoBudgetAdjustmentSessionState,
  adjustmentId: string,
): DemoBudgetAdjustmentSessionState => {
  const existing = getDemoBudgetAdjustmentsForSession(state).find((adjustment) =>
    adjustment.adjustmentId === adjustmentId);
  if (existing === undefined) throw new BudgetAdjustmentNotFoundError(adjustmentId);

  const isSeeded = getDemoBudgetAdjustments().some((adjustment) =>
    adjustment.adjustmentId === adjustmentId);
  return {
    rows: state.rows.filter((adjustment) => adjustment.adjustmentId !== adjustmentId),
    deletedAdjustmentIds: isSeeded
      ? [...state.deletedAdjustmentIds, adjustmentId].sort()
      : [...state.deletedAdjustmentIds],
  };
};
