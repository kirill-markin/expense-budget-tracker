import { z } from "zod";

import { createBadRequestError } from "@/server/api/errors";
import { budgetPlanKindSchema, categorySchema, directionSchema, finiteNumberSchema, monthSchema, parseRequiredQueryParam, parseWithSchema } from "@/server/api/validation";

type BudgetPlanBody = Readonly<{
  month: string;
  direction: "income" | "spend";
  category: string;
  kind: "base" | "modifier";
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
