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

const mapYearTotal = (total: DbPublicMonthlyShareYearTotal): PublicMonthlyShareYearTotal => ({
  year: total.year.toString(),
  category: total.category,
  amount: toFiniteNumber(total.amount),
});

export const mapPublicMonthlyCategoryShareRow = (
  row: PublicMonthlyCategoryShareRow,
): PublicMonthlyCategoryShare => ({
  label: row.label,
  currency: row.currency,
  availableMonthFrom: dateStringToMonth(row.available_month_from),
  availableMonthTo: dateStringToMonth(row.available_month_to),
  loadedMonthFrom: dateStringToMonth(row.loaded_month_from),
  loadedMonthTo: dateStringToMonth(row.loaded_month_to),
  categories: row.categories.map(mapCategory),
  cells: row.cells.map(mapCell),
  yearTotals: row.year_totals.map(mapYearTotal),
});

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
