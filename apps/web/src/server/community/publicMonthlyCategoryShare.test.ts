import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { QueryResult } from "pg";

import { clampMonthWindow } from "@/server/community/months";
import {
  getPublicMonthlyCategoryShareMetadataWithQuery,
  getPublicMonthlyCategoryShareWithQuery,
} from "@/server/community/publicMonthlyCategoryShare";

const createQueryResult = (
  rows: ReadonlyArray<Record<string, unknown>>,
): QueryResult => ({
  command: "SELECT",
  rowCount: rows.length,
  oid: 0,
  fields: [],
  rows: [...rows],
});

const readPublicShareReaderMigration = (): string =>
  readFileSync(
    fileURLToPath(new URL("../../../../../db/migrations/0050_community_public_monthly_share_visible_year_totals.sql", import.meta.url)),
    "utf8",
  );

const readPublicShareMetadataMigration = (): string =>
  readFileSync(
    fileURLToPath(new URL("../../../../../db/migrations/0048_community_public_monthly_share_metadata.sql", import.meta.url)),
    "utf8",
  );

const readPublicShareSettingsMigration = (): string =>
  readFileSync(
    fileURLToPath(new URL("../../../../../db/migrations/0046_community_monthly_category_shares.sql", import.meta.url)),
    "utf8",
  );

const countMatches = (source: string, pattern: RegExp): number =>
  Array.from(source.matchAll(pattern)).length;

const requireMatch = (source: string, pattern: RegExp): string => {
  const match = source.match(pattern);
  if (match === null) {
    throw new Error(`Expected SQL pattern was not found: ${pattern.source}`);
  }
  return match[0];
};

test("clampMonthWindow caps public share requests to the configured month count", (): void => {
  assert.deepEqual(
    clampMonthWindow("2024-01", "2026-12", 24),
    { monthFrom: "2024-01", monthTo: "2025-12" },
  );
});

test("getPublicMonthlyCategoryShareWithQuery maps database dates to public month strings", async (): Promise<void> => {
  let observedParams: ReadonlyArray<unknown> = [];
  const queryFn = async (text: string, params: ReadonlyArray<unknown>): Promise<QueryResult> => {
    assert.match(text, /community\.read_public_monthly_category_share/);
    observedParams = params;
    return createQueryResult([
      {
        label: "Shared spend",
        currency: "USD",
        available_month_from: "2025-01-01",
        available_month_to: "2025-12-01",
        loaded_month_from: "2025-03-01",
        loaded_month_to: "2025-04-01",
        categories: [
          { category: "Groceries", accessLevel: "monthly_values" },
          { category: "Travel", accessLevel: "category_only" },
        ],
        cells: [
          { month: "2025-03-01", category: "Groceries", amount: 120.5 },
          { month: "2025-04-01", category: "Groceries", amount: 80 },
        ],
        year_totals: [
          { year: 2025, category: "Groceries", amount: 999 },
        ],
      },
    ]);
  };

  const result = await getPublicMonthlyCategoryShareWithQuery(
    queryFn,
    "token-1",
    "2025-03",
    "2025-04",
  );

  assert.deepEqual(observedParams, ["token-1", "2025-03-01", "2025-04-01"]);
  assert.deepEqual(result, {
    label: "Shared spend",
    currency: "USD",
    availableMonthFrom: "2025-01",
    availableMonthTo: "2025-12",
    loadedMonthFrom: "2025-03",
    loadedMonthTo: "2025-04",
    categories: [
      { category: "Groceries", accessLevel: "monthly_values" },
      { category: "Travel", accessLevel: "category_only" },
    ],
    cells: [
      { month: "2025-03", category: "Groceries", amount: 120.5 },
      { month: "2025-04", category: "Groceries", amount: 80 },
    ],
    yearTotals: [
      { year: "2025", category: "Groceries", amount: 999 },
    ],
  });
});

test("getPublicMonthlyCategoryShareWithQuery keeps database year totals authoritative", async (): Promise<void> => {
  const queryFn = async (): Promise<QueryResult> => createQueryResult([
    {
      label: "Shared spend",
      currency: "USD",
      available_month_from: "2025-01-01",
      available_month_to: "2025-12-01",
      loaded_month_from: "2025-03-01",
      loaded_month_to: "2025-03-01",
      categories: [
        { category: "Groceries", accessLevel: "monthly_values" },
        { category: "Travel", accessLevel: "category_only" },
      ],
      cells: [
        { month: "2025-03-01", category: "Groceries", amount: 1 },
      ],
      year_totals: [
        { year: 2025, category: "Groceries", amount: 365 },
      ],
    },
  ]);

  const result = await getPublicMonthlyCategoryShareWithQuery(
    queryFn,
    "token-1",
    "2025-03",
    "2025-03",
  );

  assert.deepEqual(result?.yearTotals, [
    { year: "2025", category: "Groceries", amount: 365 },
  ]);
  assert.deepEqual(
    result?.cells.filter((cell) => cell.category === "Travel"),
    [],
  );
  assert.deepEqual(
    result?.yearTotals.filter((total) => total.category === "Travel"),
    [],
  );
});

test("getPublicMonthlyCategoryShareWithQuery returns null for every missing token equivalent", async (): Promise<void> => {
  const queryFn = async (): Promise<QueryResult> => createQueryResult([]);

  const result = await getPublicMonthlyCategoryShareWithQuery(
    queryFn,
    "missing-token",
    "2025-03",
    "2025-04",
  );

  assert.equal(result, null);
});

test("getPublicMonthlyCategoryShareMetadataWithQuery reads through the public metadata function", async (): Promise<void> => {
  let observedParams: ReadonlyArray<unknown> = [];
  const queryFn = async (text: string, params: ReadonlyArray<unknown>): Promise<QueryResult> => {
    assert.match(text, /community\.read_public_monthly_category_share_metadata/);
    observedParams = params;
    return createQueryResult([{ indexing_enabled: true }]);
  };

  const result = await getPublicMonthlyCategoryShareMetadataWithQuery(queryFn, "token-1");

  assert.deepEqual(observedParams, ["token-1"]);
  assert.deepEqual(result, { indexingEnabled: true });
});

test("getPublicMonthlyCategoryShareMetadataWithQuery returns null for missing tokens", async (): Promise<void> => {
  const queryFn = async (): Promise<QueryResult> => createQueryResult([]);

  const result = await getPublicMonthlyCategoryShareMetadataWithQuery(queryFn, "missing-token");

  assert.equal(result, null);
});

test("current public reader migration keeps amount aggregates spend-only and monthly-values-only", (): void => {
  const sql = readPublicShareReaderMigration();

  assert.match(sql, /AND item\.direction = 'spend'/);
  assert.equal(countMatches(sql, /AND entry\.kind = 'spend'/g), 2);
  assert.equal(countMatches(sql, /category\.access_level = 'monthly_values'/g), 2);
});

test("current public reader migration excludes unconvertible rows from every amount aggregate", (): void => {
  const sql = readPublicShareReaderMigration();

  assert.equal(countMatches(sql, /AND converted\.amount_report IS NOT NULL/g), 2);
});

test("current public reader migration does not expose indexing settings in the aggregate function result", (): void => {
  const sql = readPublicShareReaderMigration();

  assert.doesNotMatch(sql, /indexing_enabled/);
});

test("current public reader migration treats missing token states equivalently", (): void => {
  const sql = readPublicShareReaderMigration();

  assert.match(sql, /IF p_public_token IS NULL OR btrim\(p_public_token\) = '' THEN\s+RETURN;/);
  assert.match(sql, /key\.public_token = p_public_token/);
  assert.match(sql, /key\.revoked_at IS NULL/);
  assert.match(sql, /share\.enabled = true/);
  assert.match(sql, /share\.blocked_at IS NULL/);
  assert.match(sql, /IF v_share_id IS NULL THEN\s+RETURN;/);
});

test("current public reader migration excludes the current month using workspace timezone and sixth-day policy", (): void => {
  const sql = readPublicShareReaderMigration();

  assert.match(sql, /CURRENT_TIMESTAMP AT TIME ZONE v_timezone/);
  assert.match(sql, /WHEN EXTRACT\(DAY FROM v_local_current_date\)::integer >= 6 THEN INTERVAL '1 month'/);
  assert.match(sql, /ELSE INTERVAL '2 months'/);
  assert.match(sql, /v_available_month_to := LEAST\(\s+COALESCE\(v_config_month_to, v_latest_eligible_month\),\s+v_latest_eligible_month\s+\);/);
});

test("public metadata migration exposes only indexing through a security definer function", (): void => {
  const sql = readPublicShareMetadataMigration();

  assert.match(sql, /CREATE FUNCTION community\.read_public_monthly_category_share_metadata/);
  assert.match(sql, /SECURITY DEFINER/);
  assert.match(sql, /share\.indexing_enabled/);
  assert.match(sql, /key\.public_token = p_public_token/);
  assert.match(sql, /key\.revoked_at IS NULL/);
  assert.match(sql, /share\.enabled = true/);
  assert.match(sql, /share\.blocked_at IS NULL/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION community\.read_public_monthly_category_share_metadata\(TEXT\) TO app/);
  assert.doesNotMatch(sql, /ledger_entries/);
});

test("current public reader migration returns full eligible year totals only for visible years", (): void => {
  const sql = readPublicShareReaderMigration();
  const visibleYearTotalsSql = requireMatch(sql, /visible_year_totals AS \([\s\S]*?\n  \)\n  SELECT/);

  assert.match(sql, /CREATE OR REPLACE FUNCTION community\.read_public_monthly_category_share/);
  assert.match(sql, /visible_years AS/);
  assert.match(sql, /generate_series\(\s+v_loaded_month_from::timestamp,\s+v_loaded_month_to::timestamp,/);
  assert.match(sql, /visible_year_bounds AS/);
  assert.match(sql, /GREATEST\(v_available_month_from, make_date\(visible_year\.total_year, 1, 1\)\)/);
  assert.match(sql, /LEAST\(v_available_month_to, make_date\(visible_year\.total_year, 12, 1\)\)/);
  assert.match(visibleYearTotalsSql, /category\.access_level = 'monthly_values'/);
  assert.match(visibleYearTotalsSql, /local_entry\.local_date >= year_bound\.year_month_from/);
  assert.match(visibleYearTotalsSql, /local_entry\.local_date < \(year_bound\.year_month_to \+ INTERVAL '1 month'\)::date/);
  assert.match(visibleYearTotalsSql, /AND converted\.amount_report IS NOT NULL/);
  assert.doesNotMatch(visibleYearTotalsSql, /v_loaded_month_from/);
  assert.doesNotMatch(visibleYearTotalsSql, /v_loaded_month_to/);
  assert.doesNotMatch(sql, /configured_year_totals/);
});

test("community share objects remain unavailable to api_sql_executor", (): void => {
  const settingsSql = readPublicShareSettingsMigration();
  const readerSql = readPublicShareReaderMigration();
  const metadataSql = readPublicShareMetadataMigration();

  assert.match(settingsSql, /REVOKE ALL ON SCHEMA community FROM api_sql_executor/);
  assert.match(settingsSql, /REVOKE ALL ON TABLE community\.monthly_category_shares FROM api_sql_executor/);
  assert.match(settingsSql, /REVOKE ALL ON TABLE community\.monthly_category_share_items FROM api_sql_executor/);
  assert.match(settingsSql, /REVOKE ALL ON TABLE community\.monthly_category_share_keys FROM api_sql_executor/);
  assert.match(readerSql, /REVOKE ALL ON FUNCTION community\.read_public_monthly_category_share\(TEXT, DATE, DATE\) FROM api_sql_executor/);
  assert.match(metadataSql, /REVOKE ALL ON FUNCTION community\.read_public_monthly_category_share_metadata\(TEXT\) FROM api_sql_executor/);
});
