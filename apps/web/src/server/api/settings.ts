import { z } from "zod";

import { DATE_FORMATS, NUMBER_FORMATS, SUPPORTED_LOCALES, type DateFormat, type NumberFormat, type SupportedLocale } from "@/lib/locale";
import { createBadRequestError } from "@/server/api/errors";
import { integerRangeSchema, parseWithSchema } from "@/server/api/validation";

type ParsedUserSettingsBody = Readonly<{
  locale?: SupportedLocale;
  numberFormat?: NumberFormat;
  dateFormat?: DateFormat;
  hasLocale: boolean;
  hasNumberFormat: boolean;
  hasDateFormat: boolean;
}>;

type ParsedWorkspaceSettingsBody = Readonly<{
  reportingCurrency?: string;
  filteredCategories?: ReadonlyArray<string> | null;
  firstDayOfWeek?: number;
  timezone?: string;
  hasReportingCurrency: boolean;
  hasFilteredCategories: boolean;
  hasFirstDayOfWeek: boolean;
  hasTimezone: boolean;
}>;

const localeSchema = z.unknown().superRefine((value, ctx) => {
  if (typeof value !== "string" || !(SUPPORTED_LOCALES as ReadonlyArray<string>).includes(value)) {
    ctx.addIssue({ code: "custom", message: `Invalid locale. Expected one of: ${SUPPORTED_LOCALES.join(", ")}` });
  }
}).transform((value): SupportedLocale => value as SupportedLocale);

const numberFormatSchema = z.unknown().superRefine((value, ctx) => {
  if (typeof value !== "string" || !(NUMBER_FORMATS as ReadonlyArray<string>).includes(value)) {
    ctx.addIssue({ code: "custom", message: `Invalid numberFormat. Expected one of: ${NUMBER_FORMATS.join(", ")}` });
  }
}).transform((value): NumberFormat => value as NumberFormat);

const dateFormatSchema = z.unknown().superRefine((value, ctx) => {
  if (typeof value !== "string" || !(DATE_FORMATS as ReadonlyArray<string>).includes(value)) {
    ctx.addIssue({ code: "custom", message: `Invalid dateFormat. Expected one of: ${DATE_FORMATS.join(", ")}` });
  }
}).transform((value): DateFormat => value as DateFormat);

const reportingCurrencySchema = z.unknown().superRefine((value, ctx) => {
  if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value)) {
    ctx.addIssue({ code: "custom", message: "Invalid reportingCurrency. Expected 3-letter ISO 4217 code" });
  }
}).transform((value): string => value as string);

const filteredCategoriesSchema = z.unknown().superRefine((value, ctx) => {
  if (value === null) {
    return;
  }
  if (!Array.isArray(value) || !value.every((entry: unknown): boolean => typeof entry === "string")) {
    ctx.addIssue({ code: "custom", message: "Invalid filteredCategories. Expected array of strings or null" });
  }
}).transform((value): ReadonlyArray<string> | null => value as ReadonlyArray<string> | null);

const timezoneSchema = z.unknown().superRefine((value, ctx) => {
  if (typeof value !== "string" || value.length === 0) {
    ctx.addIssue({ code: "custom", message: "Invalid timezone. Expected non-empty string" });
  }
}).transform((value): string => value as string);

/**
 * Validate the PUT /api/user-settings request body.
 */
export const parseUserSettingsBody = (input: unknown): ParsedUserSettingsBody => {
  const parsed = parseWithSchema(input, z.object({
    locale: localeSchema.optional(),
    numberFormat: numberFormatSchema.optional(),
    dateFormat: dateFormatSchema.optional(),
  }));

  const hasLocale = parsed.locale !== undefined;
  const hasNumberFormat = parsed.numberFormat !== undefined;
  const hasDateFormat = parsed.dateFormat !== undefined;

  if (!hasLocale && !hasNumberFormat && !hasDateFormat) {
    throw createBadRequestError("No fields to update");
  }

  return {
    locale: parsed.locale,
    numberFormat: parsed.numberFormat,
    dateFormat: parsed.dateFormat,
    hasLocale,
    hasNumberFormat,
    hasDateFormat,
  };
};

/**
 * Validate the PUT /api/workspace-settings request body.
 */
export const parseWorkspaceSettingsBody = (input: unknown): ParsedWorkspaceSettingsBody => {
  const parsed = parseWithSchema(input, z.object({
    reportingCurrency: reportingCurrencySchema.optional(),
    filteredCategories: filteredCategoriesSchema.optional(),
    firstDayOfWeek: integerRangeSchema("firstDayOfWeek", 1, 7).optional(),
    timezone: timezoneSchema.optional(),
  }));

  const hasReportingCurrency = parsed.reportingCurrency !== undefined;
  const hasFilteredCategories = parsed.filteredCategories !== undefined;
  const hasFirstDayOfWeek = parsed.firstDayOfWeek !== undefined;
  const hasTimezone = parsed.timezone !== undefined;

  if (!hasReportingCurrency && !hasFilteredCategories && !hasFirstDayOfWeek && !hasTimezone) {
    throw createBadRequestError("No fields to update");
  }

  return {
    reportingCurrency: parsed.reportingCurrency,
    filteredCategories: parsed.filteredCategories,
    firstDayOfWeek: parsed.firstDayOfWeek,
    timezone: parsed.timezone,
    hasReportingCurrency,
    hasFilteredCategories,
    hasFirstDayOfWeek,
    hasTimezone,
  };
};
