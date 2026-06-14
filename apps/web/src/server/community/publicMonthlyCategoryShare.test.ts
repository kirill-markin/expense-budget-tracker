import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { QueryResult } from "pg";

import { clampMonthWindow } from "@/server/community/months";
import { getPublicMonthlyCategoryShareWithQuery } from "@/server/community/publicMonthlyCategoryShare";

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
    fileURLToPath(new URL("../../../../../db/migrations/0047_community_public_monthly_share_reader.sql", import.meta.url)),
    "utf8",
  );

const countMatches = (source: string, pattern: RegExp): number =>
  Array.from(source.matchAll(pattern)).length;

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
          { year: 2025, category: "Groceries", amount: 200.5 },
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
      { year: "2025", category: "Groceries", amount: 200.5 },
    ],
  });
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

test("public reader migration keeps amount aggregates spend-only and monthly-values-only", (): void => {
  const sql = readPublicShareReaderMigration();

  assert.match(sql, /AND item\.direction = 'spend'/);
  assert.equal(countMatches(sql, /AND entry\.kind = 'spend'/g), 2);
  assert.equal(countMatches(sql, /category\.access_level = 'monthly_values'/g), 2);
});

test("public reader migration excludes unconvertible rows from every amount aggregate", (): void => {
  const sql = readPublicShareReaderMigration();

  assert.equal(countMatches(sql, /AND converted\.amount_report IS NOT NULL/g), 2);
});

test("public reader migration does not expose indexing settings in the aggregate function result", (): void => {
  const sql = readPublicShareReaderMigration();

  assert.doesNotMatch(sql, /indexing_enabled/);
});
