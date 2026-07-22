import { fetchWithCsrf } from "@/lib/csrf";
import { buildLiveDataUrl, fetchLiveData } from "@/lib/liveDataFetch";
import type {
  BudgetAdjustment,
  CreateBudgetAdjustmentParams,
  PatchBudgetAdjustmentParams,
} from "@/server/budget/budgetAdjustments";
import type { BudgetGridResult } from "@/server/budget/getBudgetGrid";
import { z } from "zod";

const hasCodePointLengthBetween = (
  value: string,
  minLength: number,
  maxLength: number,
): boolean => {
  const length = Array.from(value).length;
  return length >= minLength && length <= maxLength;
};

const budgetAdjustmentSchema: z.ZodType<BudgetAdjustment> = z.object({
  adjustmentId: z.string().refine((value): boolean => hasCodePointLengthBetween(value, 1, 200), {
    message: "must contain between 1 and 200 characters",
  }),
  month: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/),
  direction: z.enum(["income", "spend"]),
  category: z.string().refine((value): boolean => hasCodePointLengthBetween(value, 1, 200), {
    message: "must contain between 1 and 200 characters",
  }),
  amount: z.number().safe().int(),
  note: z.string().refine((value): boolean => hasCodePointLengthBetween(value, 0, 2000), {
    message: "must contain at most 2000 characters",
  }).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export const parseBudgetAdjustment = (input: unknown, context: string): BudgetAdjustment => {
  const parsed = budgetAdjustmentSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`${context} is invalid: ${parsed.error.message}`);
  }
  return parsed.data;
};

const deleteBudgetAdjustmentResponseSchema = z.object({ ok: z.literal(true) }).strict();

export type DeleteBudgetAdjustmentOutcome = "deleted" | "already-absent";

const readJsonResponse = async <T>(
  response: Response,
  operation: string,
  schema: z.ZodType<T>,
): Promise<T> => {
  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(`${operation} failed: ${response.status} ${responseBody}`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(responseBody) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${operation} returned invalid JSON: ${reason}. Response body: ${responseBody}`);
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(`${operation} returned an invalid response: ${parsed.error.message}. Response body: ${responseBody}`);
  }
  return parsed.data;
};

export const readBudgetAdjustmentResponse = async (
  response: Response,
  operation: string,
): Promise<BudgetAdjustment> =>
  readJsonResponse(response, operation, budgetAdjustmentSchema);

/**
 * Reads the budget grid for the current client-visible range.
 *
 * The refresh token keeps this client-side read aligned with the latest
 * server-rendered route refresh without resetting the current month window.
 */
export const fetchBudgetRange = async (
  monthFrom: string,
  monthTo: string,
  planFrom: string,
  actualTo: string,
  refreshToken: string,
): Promise<BudgetGridResult> => {
  const params = new URLSearchParams({
    monthFrom,
    monthTo,
    planFrom,
    actualTo,
  });
  const url = buildLiveDataUrl("/api/budget-grid", params, refreshToken);
  const response = await fetchLiveData(url);
  if (!response.ok) {
    throw new Error(`Budget API error: ${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<BudgetGridResult>;
};

export const postBudgetPlan = async (params: {
  month: string;
  direction: string;
  category: string;
  kind: "base" | "modifier";
  plannedValue: number;
}): Promise<void> => {
  const response = await fetchWithCsrf("/api/budget-plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!response.ok) {
    throw new Error(`Budget plan update failed: ${response.status} ${await response.text()}`);
  }
};

export const postBudgetPlanFill = async (params: {
  fromMonth: string;
  direction: string;
  category: string;
  baseValue: number;
}): Promise<void> => {
  const response = await fetchWithCsrf("/api/budget-plan-fill", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!response.ok) {
    throw new Error(`Budget plan fill failed: ${response.status} ${await response.text()}`);
  }
};

export const createBudgetAdjustment = async (
  params: CreateBudgetAdjustmentParams,
): Promise<BudgetAdjustment> => {
  const response = await fetchWithCsrf("/api/budget-adjustments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  return readBudgetAdjustmentResponse(response, "Budget adjustment create");
};

export const patchBudgetAdjustment = async (
  adjustmentId: string,
  params: PatchBudgetAdjustmentParams,
): Promise<BudgetAdjustment> => {
  const response = await fetchWithCsrf(`/api/budget-adjustments/${encodeURIComponent(adjustmentId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  return readBudgetAdjustmentResponse(response, `Budget adjustment ${adjustmentId} update`);
};

export const readBudgetAdjustmentDeleteResponse = async (
  response: Response,
  adjustmentId: string,
): Promise<DeleteBudgetAdjustmentOutcome> => {
  if (response.status === 404) {
    return "already-absent";
  }
  await readJsonResponse(
    response,
    `Budget adjustment ${adjustmentId} delete`,
    deleteBudgetAdjustmentResponseSchema,
  );
  return "deleted";
};

export const deleteBudgetAdjustment = async (
  adjustmentId: string,
): Promise<DeleteBudgetAdjustmentOutcome> => {
  const response = await fetchWithCsrf(`/api/budget-adjustments/${encodeURIComponent(adjustmentId)}`, {
    method: "DELETE",
  });
  return readBudgetAdjustmentDeleteResponse(response, adjustmentId);
};

export const fetchComment = async (month: string, direction: string, category: string): Promise<string | null> => {
  const params = new URLSearchParams({ month, direction, category });
  const response = await fetchLiveData(`/api/budget-comment?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`Comment fetch failed: ${response.status} ${await response.text()}`);
  }
  const data = await response.json() as { comment: string | null };
  return data.comment;
};

export const postComment = async (params: {
  month: string;
  direction: string;
  category: string;
  comment: string;
}): Promise<void> => {
  const response = await fetchWithCsrf("/api/budget-comment", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!response.ok) {
    throw new Error(`Comment save failed: ${response.status} ${await response.text()}`);
  }
};
