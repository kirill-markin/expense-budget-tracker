import { z } from "zod";

import { getCurrentMonth } from "@/lib/monthUtils";
import { createBadRequestError } from "@/server/api/errors";
import { adjustmentIdSchema, adjustmentUuidSchema, budgetAdjustmentNoteSchema, budgetPlanKindSchema, categorySchema, directionSchema, finiteIntegerSchema, finiteNumberSchema, monthSchema, parseRequiredQueryParam, parseWithSchema } from "@/server/api/validation";
import type { CreateBudgetAdjustmentParams, PatchBudgetAdjustmentParams } from "@/server/budget/budgetAdjustments";

type BudgetPlanBody = Readonly<{
  month: string;
  direction: "income" | "spend";
  category: string;
  kind: "base";
  plannedValue: number;
}>;

type BudgetPlanFillBody = Readonly<{
  fromMonth: string;
  direction: "income" | "spend";
  category: string;
  baseValue: number;
}>;

type BudgetCommentQuery = Readonly<{
  month: string;
  direction: "income" | "spend";
  category: string;
}>;

type BudgetCommentBody = Readonly<{
  month: string;
  direction: "income" | "spend";
  category: string;
  comment: string;
}>;

type BudgetMonthRangeQuery = Readonly<{
  monthFrom: string;
  monthTo: string;
}>;

type BudgetGridQuery = Readonly<{
  monthFrom: string;
  monthTo: string;
  planFrom: string;
  actualTo: string;
}>;

type FxBreakdownQuery = Readonly<{
  month: string;
}>;

const budgetPlanBodySchema = z.object({
  month: monthSchema,
  direction: directionSchema,
  category: categorySchema,
  kind: budgetPlanKindSchema,
  plannedValue: finiteNumberSchema("plannedValue"),
});

const currentOrFutureMonthSchema = monthSchema.superRefine((value, ctx) => {
  if (value < getCurrentMonth()) {
    ctx.addIssue({ code: "custom", message: "Invalid month. Expected current or future month" });
  }
});

const budgetAdjustmentCreateBodySchema = z.object({
  adjustmentId: adjustmentUuidSchema,
  month: currentOrFutureMonthSchema,
  direction: directionSchema,
  category: categorySchema,
  amount: finiteIntegerSchema("amount"),
  note: budgetAdjustmentNoteSchema,
}).strict();

const budgetAdjustmentPatchBodySchema = z.object({
  amount: finiteIntegerSchema("amount").optional(),
  note: budgetAdjustmentNoteSchema.optional(),
  month: currentOrFutureMonthSchema.optional(),
  category: categorySchema.optional(),
}).strict().refine(
  (value): boolean => Object.keys(value).length > 0,
  { message: "Budget adjustment patch must include at least one editable field" },
);

const fromMonthSchema = z.unknown().superRefine((value, ctx) => {
  if (typeof value !== "string") {
    ctx.addIssue({ code: "custom", message: "Invalid fromMonth format. Expected YYYY-MM" });
    return;
  }
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(value)) {
    ctx.addIssue({ code: "custom", message: "Invalid fromMonth format. Expected YYYY-MM" });
    return;
  }
  if (value.endsWith("-12")) {
    ctx.addIssue({ code: "custom", message: "Cannot fill from December — no following months in the same year" });
  }
}).transform((value): string => value as string);

const budgetPlanFillBodySchema = z.object({
  fromMonth: fromMonthSchema,
  direction: directionSchema,
  category: categorySchema,
  baseValue: finiteNumberSchema("baseValue"),
});

const budgetCommentBodySchema = z.object({
  month: monthSchema,
  direction: directionSchema,
  category: categorySchema,
  comment: z.unknown().superRefine((value, ctx) => {
    if (typeof value !== "string" || value.length > 2000) {
      ctx.addIssue({ code: "custom", message: "Invalid comment. Expected string (max 2000 chars)" });
    }
  }).transform((value): string => value as string),
});

/**
 * Validate the POST /api/budget-plan request body.
 */
export const parseBudgetPlanBody = (input: unknown): BudgetPlanBody =>
  parseWithSchema(input, budgetPlanBodySchema);

/**
 * Validate the POST /api/budget-plan-fill request body.
 */
export const parseBudgetPlanFillBody = (input: unknown): BudgetPlanFillBody =>
  parseWithSchema(input, budgetPlanFillBodySchema);

/**
 * Validate the POST /api/budget-adjustments request body.
 */
export const parseBudgetAdjustmentCreateBody = (input: unknown): CreateBudgetAdjustmentParams =>
  parseWithSchema(input, budgetAdjustmentCreateBodySchema);

/**
 * Validate the PATCH /api/budget-adjustments/[adjustmentId] request body.
 */
export const parseBudgetAdjustmentPatchBody = (input: unknown): PatchBudgetAdjustmentParams =>
  parseWithSchema(input, budgetAdjustmentPatchBodySchema);

/**
 * Validate a budget adjustment route identifier.
 */
export const parseBudgetAdjustmentId = (input: unknown): string =>
  parseWithSchema(input, adjustmentIdSchema);

/**
 * Validate the GET /api/budget-comment query string.
 */
export const parseBudgetCommentQuery = (searchParams: URLSearchParams): BudgetCommentQuery => ({
  month: parseRequiredQueryParam(searchParams, "month", monthSchema, "Invalid month format. Expected YYYY-MM"),
  direction: parseRequiredQueryParam(searchParams, "direction", directionSchema, "Invalid direction. Expected 'income' or 'spend'"),
  category: parseRequiredQueryParam(searchParams, "category", categorySchema, "Invalid category. Expected non-empty string (max 200 chars)"),
});

/**
 * Validate the POST /api/budget-comment request body.
 */
export const parseBudgetCommentBody = (input: unknown): BudgetCommentBody =>
  parseWithSchema(input, budgetCommentBodySchema);

/**
 * Validate the month-range query used by budget comment presence endpoints.
 */
export const parseBudgetMonthRangeQuery = (searchParams: URLSearchParams): BudgetMonthRangeQuery => {
  const monthFrom = searchParams.get("monthFrom");
  const monthTo = searchParams.get("monthTo");

  if (monthFrom === null || monthTo === null) {
    throw createBadRequestError("Missing required query params: monthFrom, monthTo");
  }

  const parsedMonthFrom = parseWithSchema(monthFrom, monthSchema);
  const parsedMonthTo = parseWithSchema(monthTo, monthSchema);
  if (parsedMonthFrom > parsedMonthTo) {
    throw createBadRequestError("monthFrom must be <= monthTo");
  }

  return { monthFrom: parsedMonthFrom, monthTo: parsedMonthTo };
};

/**
 * Validate the GET /api/budget-grid query string.
 */
export const parseBudgetGridQuery = (searchParams: URLSearchParams): BudgetGridQuery => {
  const monthFrom = searchParams.get("monthFrom");
  const monthTo = searchParams.get("monthTo");
  const planFrom = searchParams.get("planFrom");
  const actualTo = searchParams.get("actualTo");

  if (monthFrom === null || monthTo === null || planFrom === null || actualTo === null) {
    throw createBadRequestError("Missing required query params: monthFrom, monthTo, planFrom, actualTo");
  }

  const parsedMonthFrom = parseWithSchema(monthFrom, monthSchema);
  const parsedMonthTo = parseWithSchema(monthTo, monthSchema);
  const parsedPlanFrom = parseWithSchema(planFrom, monthSchema);
  const parsedActualTo = parseWithSchema(actualTo, monthSchema);

  if (parsedMonthFrom > parsedMonthTo) {
    throw createBadRequestError("monthFrom must be <= monthTo");
  }

  return {
    monthFrom: parsedMonthFrom,
    monthTo: parsedMonthTo,
    planFrom: parsedPlanFrom,
    actualTo: parsedActualTo,
  };
};

/**
 * Validate the GET /api/fx-breakdown query string.
 */
export const parseFxBreakdownQuery = (searchParams: URLSearchParams): FxBreakdownQuery => ({
  month: parseRequiredQueryParam(searchParams, "month", monthSchema, "Missing required query param: month"),
});
