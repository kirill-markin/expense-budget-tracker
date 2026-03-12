import { z } from "zod";

import type { TransactionsFilter } from "@/server/transactions/getTransactions";
import { accountIdSchema, counterpartySchema, currencySchema, entryIdSchema, finiteNumberSchema, isoDateTimeSchema, noteSchema, nullableCategorySchema, parseOptionalQueryParam, parseRepeatedQueryParam, parseWithSchema, transactionKindSchema } from "@/server/api/validation";

type CreateTransactionBody = Readonly<{
  ts: string;
  accountId: string;
  amount: number;
  currency: string;
  kind: "income" | "spend" | "transfer";
  category: string | null;
  counterparty: string | null;
  note: string | null;
}>;

type UpdateTransactionBody = Readonly<{
  entryId: string;
  category: string | null;
  note: string | null;
  counterparty: string | null;
  kind: "income" | "spend" | "transfer";
  ts: string;
  accountId: string;
  amount: number;
  currency: string;
}>;

type DeleteTransactionBody = Readonly<{
  entryId: string;
}>;

const DEFAULT_LIMIT = 100;
const DEFAULT_OFFSET = 0;
const DEFAULT_SORT_KEY = "ts";
const DEFAULT_SORT_DIR = "desc";
const MAX_LIMIT = 500;
const VALID_SORT_KEYS = new Set([
  "ts", "accountId", "amount", "amountAbs", "amountUsdAbs", "currency", "kind", "category", "counterparty",
]);

const dateParamSchema = (fieldName: string) =>
  z.unknown().superRefine((value, ctx) => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      ctx.addIssue({ code: "custom", message: `${fieldName} must be YYYY-MM-DD` });
    }
  }).transform((value): string => value as string);

const maxLengthParamSchema = (message: string, maxLength: number) =>
  z.unknown().superRefine((value, ctx) => {
    if (typeof value !== "string" || value.length > maxLength) {
      ctx.addIssue({ code: "custom", message });
    }
  }).transform((value): string => value as string);

const queryNumberSchema = (message: string, check: (value: number) => boolean) =>
  z.unknown().superRefine((value, ctx) => {
    if (typeof value !== "string") {
      ctx.addIssue({ code: "custom", message });
      return;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || !check(parsed)) {
      ctx.addIssue({ code: "custom", message });
    }
  }).transform((value): number => Number(value as string));

const sortKeySchema = z.unknown().superRefine((value, ctx) => {
  if (typeof value !== "string" || !VALID_SORT_KEYS.has(value)) {
    ctx.addIssue({ code: "custom", message: `sortKey must be one of: ${[...VALID_SORT_KEYS].join(", ")}` });
  }
}).transform((value): string => value as string);

const sortDirSchema = z.unknown().superRefine((value, ctx) => {
  if (value !== "asc" && value !== "desc") {
    ctx.addIssue({ code: "custom", message: "sortDir must be asc or desc" });
  }
}).transform((value): "asc" | "desc" => value as "asc" | "desc");

const categoriesEntrySchema = maxLengthParamSchema("categories entry too long (max 200 chars)", 200);

const transactionBodySchema = z.object({
  ts: isoDateTimeSchema,
  accountId: accountIdSchema,
  amount: finiteNumberSchema("amount"),
  currency: currencySchema,
  kind: transactionKindSchema,
  category: nullableCategorySchema,
  counterparty: counterpartySchema,
  note: noteSchema,
});

/**
 * Validate the POST /api/transactions/create request body.
 */
export const parseTransactionsCreateBody = (input: unknown): CreateTransactionBody =>
  parseWithSchema(input, transactionBodySchema);

/**
 * Validate the POST /api/transactions/update request body.
 */
export const parseTransactionsUpdateBody = (input: unknown): UpdateTransactionBody =>
  parseWithSchema(input, transactionBodySchema.extend({ entryId: entryIdSchema }));

/**
 * Validate the POST /api/transactions/delete request body.
 */
export const parseTransactionsDeleteBody = (input: unknown): DeleteTransactionBody =>
  parseWithSchema(input, z.object({ entryId: entryIdSchema }));

/**
 * Validate the GET /api/transactions query string.
 */
export const parseTransactionsFilterQuery = (searchParams: URLSearchParams): TransactionsFilter => {
  const limitRaw = searchParams.get("limit") ?? String(DEFAULT_LIMIT);
  const offsetRaw = searchParams.get("offset") ?? String(DEFAULT_OFFSET);
  const sortKeyRaw = searchParams.get("sortKey") ?? DEFAULT_SORT_KEY;
  const sortDirRaw = searchParams.get("sortDir") ?? DEFAULT_SORT_DIR;

  const limit = parseWithSchema(limitRaw, queryNumberSchema(`limit must be 1..${MAX_LIMIT}`, (value: number): boolean => value >= 1 && value <= MAX_LIMIT));
  const offset = parseWithSchema(offsetRaw, queryNumberSchema("offset must be >= 0", (value: number): boolean => value >= 0));
  const sortKey = parseWithSchema(sortKeyRaw, sortKeySchema);
  const sortDir = parseWithSchema(sortDirRaw, sortDirSchema);

  const dateFrom = parseOptionalQueryParam(searchParams, "dateFrom", dateParamSchema("dateFrom"));
  const dateTo = parseOptionalQueryParam(searchParams, "dateTo", dateParamSchema("dateTo"));
  const accountId = parseOptionalQueryParam(searchParams, "accountId", maxLengthParamSchema("accountId too long (max 200 chars)", 200));
  const kind = parseOptionalQueryParam(searchParams, "kind", maxLengthParamSchema("kind too long (max 20 chars)", 20));
  const category = parseOptionalQueryParam(searchParams, "category", maxLengthParamSchema("category too long (max 200 chars)", 200));
  const categories = parseRepeatedQueryParam(searchParams, "categories", categoriesEntrySchema);

  return {
    dateFrom,
    dateTo,
    accountId,
    kind,
    category,
    categories: categories.length > 0 ? categories : null,
    sortKey,
    sortDir,
    limit,
    offset,
  };
};
