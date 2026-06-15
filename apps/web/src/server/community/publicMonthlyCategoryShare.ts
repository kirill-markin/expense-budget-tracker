import type { QueryResult } from "pg";

import { query } from "@/server/db";
import { dateStringToMonth, monthToDateString } from "@/server/community/months";
import type {
  PublicMonthlyCategoryShare,
  PublicMonthlyShareAccessLevel,
  PublicMonthlyShareCategory,
  PublicMonthlyShareCell,
  PublicMonthlyShareYearTotal,
} from "@/server/community/publicMonthlyCategoryShareTypes";

type PublicMonthlyCategoryShareRow = Readonly<{
  label: string;
  currency: string;
  available_month_from: string | null;
  available_month_to: string | null;
  loaded_month_from: string | null;
  loaded_month_to: string | null;
  categories: ReadonlyArray<DbPublicMonthlyShareCategory>;
  cells: ReadonlyArray<DbPublicMonthlyShareCell>;
  year_totals: ReadonlyArray<DbPublicMonthlyShareYearTotal>;
}>;

type DbPublicMonthlyShareCategory = Readonly<{
  category: string;
  accessLevel: PublicMonthlyShareAccessLevel;
}>;

type DbPublicMonthlyShareCell = Readonly<{
  month: string;
  category: string;
  amount: number;
}>;

type DbPublicMonthlyShareYearTotal = Readonly<{
  year: number;
  category: string;
  amount: number;
}>;

export type PublicMonthlyCategoryShareMetadata = Readonly<{
  indexingEnabled: boolean;
}>;

type PublicMonthlyCategoryShareMetadataRow = Readonly<{
  indexing_enabled: boolean;
}>;

type BareQueryFn = (text: string, params: ReadonlyArray<unknown>) => Promise<QueryResult>;

const PUBLIC_MONTHLY_CATEGORY_SHARE_QUERY = `
  SELECT
    label,
    currency,
    available_month_from::text AS available_month_from,
    available_month_to::text AS available_month_to,
    loaded_month_from::text AS loaded_month_from,
    loaded_month_to::text AS loaded_month_to,
    categories,
    cells,
    year_totals
  FROM community.read_public_monthly_category_share($1, $2::date, $3::date)
`;

const PUBLIC_MONTHLY_CATEGORY_SHARE_METADATA_QUERY = `
  SELECT indexing_enabled
  FROM community.read_public_monthly_category_share_metadata($1)
`;

const toFiniteNumber = (value: number): number => {
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid numeric public monthly share value from database: ${value}`);
  }
  return value;
};

const requiredMonthFromDateString = (dateString: string): string => {
  const month = dateStringToMonth(dateString);
  if (month === null) {
    throw new Error("Invalid null public monthly share month from database");
  }
  return month;
};

const mapCategory = (category: DbPublicMonthlyShareCategory): PublicMonthlyShareCategory => ({
  category: category.category,
  accessLevel: category.accessLevel,
});

const mapCell = (cell: DbPublicMonthlyShareCell): PublicMonthlyShareCell => ({
  month: requiredMonthFromDateString(cell.month),
  category: cell.category,
  amount: toFiniteNumber(cell.amount),
});

const mapYearTotal = (total: DbPublicMonthlyShareYearTotal): PublicMonthlyShareYearTotal => {
  if (!Number.isInteger(total.year)) {
    throw new Error(`Invalid public monthly share year from database: ${total.year}`);
  }
  return {
    year: String(total.year),
    category: total.category,
    amount: toFiniteNumber(total.amount),
  };
};

const compareYearTotals = (
  left: PublicMonthlyShareYearTotal,
  right: PublicMonthlyShareYearTotal,
): number => {
  const yearCompare = left.year.localeCompare(right.year);
  if (yearCompare !== 0) {
    return yearCompare;
  }
  return left.category.localeCompare(right.category);
};

export const mapPublicMonthlyCategoryShareRow = (
  row: PublicMonthlyCategoryShareRow,
): PublicMonthlyCategoryShare => {
  const cells = row.cells.map(mapCell);
  return {
    label: row.label,
    currency: row.currency,
    availableMonthFrom: dateStringToMonth(row.available_month_from),
    availableMonthTo: dateStringToMonth(row.available_month_to),
    loadedMonthFrom: dateStringToMonth(row.loaded_month_from),
    loadedMonthTo: dateStringToMonth(row.loaded_month_to),
    categories: row.categories.map(mapCategory),
    cells,
    yearTotals: row.year_totals.map(mapYearTotal).sort(compareYearTotals),
  };
};

export const getPublicMonthlyCategoryShareWithQuery = async (
  queryFn: BareQueryFn,
  publicToken: string,
  monthFrom: string,
  monthTo: string,
): Promise<PublicMonthlyCategoryShare | null> => {
  const result = await queryFn(PUBLIC_MONTHLY_CATEGORY_SHARE_QUERY, [
    publicToken,
    monthToDateString(monthFrom),
    monthToDateString(monthTo),
  ]);

  const row = result.rows[0] as PublicMonthlyCategoryShareRow | undefined;
  if (row === undefined) {
    return null;
  }

  return mapPublicMonthlyCategoryShareRow(row);
};

export const getPublicMonthlyCategoryShare = async (
  publicToken: string,
  monthFrom: string,
  monthTo: string,
): Promise<PublicMonthlyCategoryShare | null> =>
  getPublicMonthlyCategoryShareWithQuery(query, publicToken, monthFrom, monthTo);

export const getPublicMonthlyCategoryShareMetadataWithQuery = async (
  queryFn: BareQueryFn,
  publicToken: string,
): Promise<PublicMonthlyCategoryShareMetadata | null> => {
  const result = await queryFn(PUBLIC_MONTHLY_CATEGORY_SHARE_METADATA_QUERY, [publicToken]);
  const row = result.rows[0] as PublicMonthlyCategoryShareMetadataRow | undefined;
  if (row === undefined) {
    return null;
  }
  return {
    indexingEnabled: row.indexing_enabled,
  };
};

export const getPublicMonthlyCategoryShareMetadata = async (
  publicToken: string,
): Promise<PublicMonthlyCategoryShareMetadata | null> =>
  getPublicMonthlyCategoryShareMetadataWithQuery(query, publicToken);
