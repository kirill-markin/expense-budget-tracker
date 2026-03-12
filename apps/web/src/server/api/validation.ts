/**
 * Shared zod schema builders and request parsing helpers for Next.js API routes.
 *
 * These helpers preserve existing client-facing validation messages while
 * removing repeated inline parsing and validation logic from route handlers.
 */
import { z, type RefinementCtx, type ZodType } from "zod";

import { createBadRequestError, fromZodError } from "@/server/api/errors";

const MONTH_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const addCustomIssue = (ctx: RefinementCtx, message: string): void => {
  ctx.addIssue({ code: "custom", message });
};

const createStringSchema = (check: (value: string) => boolean, message: string): ZodType<string> =>
  z.unknown().superRefine((value, ctx) => {
    if (typeof value !== "string" || !check(value)) {
      addCustomIssue(ctx, message);
    }
  }).transform((value): string => value as string);

const createNullableStringSchema = (
  check: (value: string) => boolean,
  message: string,
): ZodType<string | null> =>
  z.unknown().superRefine((value, ctx) => {
    if (value === null) {
      return;
    }
    if (typeof value !== "string" || !check(value)) {
      addCustomIssue(ctx, message);
    }
  }).transform((value): string | null => value as string | null);

/**
 * Accept a calendar month string in YYYY-MM form.
 */
export const monthSchema: ZodType<string> = createStringSchema(
  (value: string): boolean => MONTH_PATTERN.test(value),
  "Invalid month format. Expected YYYY-MM",
);

/**
 * Accept an ISO date string in YYYY-MM-DD form.
 */
export const isoDateSchema: ZodType<string> = createStringSchema(
  (value: string): boolean => ISO_DATE_PATTERN.test(value),
  "Invalid date. Expected YYYY-MM-DD",
);

/**
 * Accept an ISO 8601 timestamp string understood by Date.parse().
 */
export const isoDateTimeSchema: ZodType<string> = createStringSchema(
  (value: string): boolean => !Number.isNaN(Date.parse(value)),
  "Invalid ts. Expected ISO 8601 date string",
);

/**
 * Accept a budget direction value: income or spend.
 */
export const directionSchema: ZodType<"income" | "spend"> = createStringSchema(
  (value: string): boolean => value === "income" || value === "spend",
  "Invalid direction. Expected 'income' or 'spend'",
) as ZodType<"income" | "spend">;

/**
 * Accept a budget line kind: base or modifier.
 */
export const budgetPlanKindSchema: ZodType<"base" | "modifier"> = createStringSchema(
  (value: string): boolean => value === "base" || value === "modifier",
  "Invalid kind. Expected 'base' or 'modifier'",
) as ZodType<"base" | "modifier">;

/**
 * Accept a transaction kind: income, spend, or transfer.
 */
export const transactionKindSchema: ZodType<"income" | "spend" | "transfer"> = createStringSchema(
  (value: string): boolean => value === "income" || value === "spend" || value === "transfer",
  "Invalid kind. Expected one of: income, spend, transfer",
) as ZodType<"income" | "spend" | "transfer">;

/**
 * Accept a non-empty category string up to 200 characters.
 */
export const categorySchema: ZodType<string> = createStringSchema(
  (value: string): boolean => value.length > 0 && value.length <= 200,
  "Invalid category. Expected non-empty string (max 200 chars)",
);

/**
 * Accept a nullable category string up to 200 characters.
 */
export const nullableCategorySchema: ZodType<string | null> = createNullableStringSchema(
  (value: string): boolean => value.length <= 200,
  "Invalid category. Expected string (max 200 chars) or null",
);

/**
 * Accept a nullable counterparty string up to 200 characters.
 */
export const counterpartySchema: ZodType<string | null> = createNullableStringSchema(
  (value: string): boolean => value.length <= 200,
  "Invalid counterparty. Expected string (max 200 chars) or null",
);

/**
 * Accept a nullable note string up to 1000 characters.
 */
export const noteSchema: ZodType<string | null> = createNullableStringSchema(
  (value: string): boolean => value.length <= 1000,
  "Invalid note. Expected string (max 1000 chars) or null",
);

/**
 * Accept a short uppercase currency code used by the current API.
 */
export const currencySchema: ZodType<string> = createStringSchema(
  (value: string): boolean => value.length <= 10,
  "Invalid currency. Expected string (max 10 chars)",
);

/**
 * Accept an account identifier string up to 200 characters.
 */
export const accountIdSchema: ZodType<string> = createStringSchema(
  (value: string): boolean => value.length <= 200,
  "Invalid accountId. Expected string (max 200 chars)",
);

/**
 * Accept an entry identifier string up to 200 characters.
 */
export const entryIdSchema: ZodType<string> = createStringSchema(
  (value: string): boolean => value.length > 0 && value.length <= 200,
  "Invalid entryId. Expected non-empty string (max 200 chars)",
);

/**
 * Accept a finite number for the named field.
 */
export const finiteNumberSchema = (fieldName: string): ZodType<number> =>
  z.unknown().superRefine((value, ctx) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      addCustomIssue(ctx, `Invalid ${fieldName}. Expected finite number`);
    }
  }).transform((value): number => value as number);

/**
 * Accept an integer value inside the inclusive range for the named field.
 */
export const integerRangeSchema = (fieldName: string, min: number, max: number): ZodType<number> =>
  z.unknown().superRefine((value, ctx) => {
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      addCustomIssue(ctx, `Invalid ${fieldName}. Expected integer ${min}-${max}`);
    }
  }).transform((value): number => value as number);

/**
 * Parse an arbitrary input with the provided zod schema.
 *
 * Throws ApiRouteError when schema validation fails.
 */
export const parseWithSchema = <T>(input: unknown, schema: ZodType<T>): T => {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw fromZodError(result.error);
  }
  return result.data;
};

/**
 * Parse a JSON request body and validate it with the provided zod schema.
 *
 * Throws ApiRouteError with status 400 when the body is not valid JSON or when
 * the parsed payload does not satisfy the schema.
 */
export const parseJsonBody = async <T>(request: Request, schema: ZodType<T>): Promise<T> => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw createBadRequestError("Invalid JSON body");
  }
  return parseWithSchema(body, schema);
};

/**
 * Read and validate a required query parameter.
 *
 * Throws ApiRouteError with the provided missing-parameter message when the key
 * is absent, or a 400 validation error when the value fails the schema.
 */
export const parseRequiredQueryParam = <T>(
  searchParams: URLSearchParams,
  key: string,
  schema: ZodType<T>,
  missingMessage: string,
): T => {
  const value = searchParams.get(key);
  if (value === null) {
    throw createBadRequestError(missingMessage);
  }
  return parseWithSchema(value, schema);
};

/**
 * Read and validate an optional query parameter.
 *
 * Returns null when the key is absent and throws ApiRouteError when a present
 * value fails validation.
 */
export const parseOptionalQueryParam = <T>(
  searchParams: URLSearchParams,
  key: string,
  schema: ZodType<T>,
): T | null => {
  const value = searchParams.get(key);
  if (value === null) {
    return null;
  }
  return parseWithSchema(value, schema);
};

/**
 * Read and validate all values for a repeated query parameter.
 *
 * Returns an empty array when the key is absent and throws ApiRouteError when
 * any value fails validation.
 */
export const parseRepeatedQueryParam = <T>(
  searchParams: URLSearchParams,
  key: string,
  schema: ZodType<T>,
): ReadonlyArray<T> =>
  searchParams.getAll(key).map((value: string): T => parseWithSchema(value, schema));
