import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResult, QueryResultRow } from "pg";

import {
  ACCOUNT_SUGGESTIONS_QUERY,
  getAccountSuggestionsWithQuery,
} from "@/server/accounts/getAccountSuggestions";
import type { QueryFn } from "@/server/db/contextRunner";
import {
  getDemoAccountSuggestions,
  getDemoBalancesSummary,
  getDemoTransactionsPage,
} from "@/server/demo/data";
import type { TransactionsFilter } from "@/server/transactions/getTransactions";

const DAY_MS = 24 * 60 * 60 * 1000;
const CURRENT_TIME_MS = Date.parse("2026-07-17T12:00:00.000Z");

const createQueryResult = (rows: ReadonlyArray<QueryResultRow>): QueryResult => ({
  command: "SELECT",
  rowCount: rows.length,
  oid: 0,
  fields: [],
  rows: [...rows],
});

test("getAccountSuggestionsWithQuery filters inactive accounts and preserves latest-operation ordering", async (): Promise<void> => {
  const rows: ReadonlyArray<QueryResultRow> = [
    {
      account_id: "inactive-transfer-only",
      currency: "USD",
      balance: 0,
      last_non_transfer_ms: null,
      latest_operation_ms: CURRENT_TIME_MS,
    },
    {
      account_id: "transfer-recent",
      currency: "EUR",
      balance: 0,
      last_non_transfer_ms: CURRENT_TIME_MS - DAY_MS,
      latest_operation_ms: CURRENT_TIME_MS - 1_000,
    },
    {
      account_id: "account-a",
      currency: "USD",
      balance: 25,
      last_non_transfer_ms: null,
      latest_operation_ms: CURRENT_TIME_MS - 2_000,
    },
    {
      account_id: "account-b",
      currency: "GBP",
      balance: -10,
      last_non_transfer_ms: CURRENT_TIME_MS - 365 * DAY_MS,
      latest_operation_ms: CURRENT_TIME_MS - 2_000,
    },
    {
      account_id: "inactive-old",
      currency: "JPY",
      balance: 0,
      last_non_transfer_ms: CURRENT_TIME_MS - 90 * DAY_MS - 1,
      latest_operation_ms: CURRENT_TIME_MS - 3_000,
    },
  ];
  let receivedSql = "";
  const queryFn: QueryFn = async (sql, params): Promise<QueryResult> => {
    receivedSql = sql;
    assert.deepEqual(params, []);
    return createQueryResult(rows);
  };

  const suggestions = await getAccountSuggestionsWithQuery(queryFn, CURRENT_TIME_MS);

  assert.deepEqual(suggestions, [
    { accountId: "transfer-recent", currency: "EUR" },
    { accountId: "account-a", currency: "USD" },
    { accountId: "account-b", currency: "GBP" },
  ]);
  assert.equal(receivedSql, ACCOUNT_SUGGESTIONS_QUERY);
  assert.match(receivedSql, /MAX\(CASE WHEN le\.kind != 'transfer' THEN le\.ts END\)/);
  assert.match(receivedSql, /MAX\(le\.ts\)/);
  assert.match(receivedSql, /ORDER BY MAX\(le\.ts\) DESC, a\.account_id/);
  assert.match(receivedSql, /le\.workspace_id = current_setting\('app\.workspace_id', true\)/);
  assert.doesNotMatch(receivedSql, /COUNT\s*\(/i);
});

test("getAccountSuggestionsWithQuery rejects invalid database values", async (): Promise<void> => {
  const queryFn: QueryFn = async (): Promise<QueryResult> =>
    createQueryResult([
      {
        account_id: "checking",
        currency: "USD",
        balance: "10",
        last_non_transfer_ms: CURRENT_TIME_MS,
        latest_operation_ms: CURRENT_TIME_MS,
      },
    ]);

  await assert.rejects(
    getAccountSuggestionsWithQuery(queryFn, CURRENT_TIME_MS),
    /Invalid account suggestion database row at index 0: balance:/,
  );
});

const ALL_DEMO_TRANSACTIONS_FILTER: TransactionsFilter = {
  dateFrom: null,
  dateTo: null,
  accountId: null,
  accountIds: null,
  kind: null,
  kinds: null,
  currencies: null,
  category: null,
  categories: null,
  counterparties: null,
  businessPersonalTransfers: false,
  sortKey: "ts",
  sortDir: "desc",
  limit: 10_000,
  offset: 0,
};

test("getDemoAccountSuggestions matches active demo accounts ordered by every ledger operation", (): void => {
  const suggestions = getDemoAccountSuggestions();
  const activeAccounts = getDemoBalancesSummary().accounts.filter((account) => account.status === "active");
  const page = getDemoTransactionsPage(ALL_DEMO_TRANSACTIONS_FILTER);
  assert.equal(page.entries.length, page.total);

  const latestOperationTimeByAccount = new Map<string, number>();
  for (const entry of page.entries) {
    const operationTimeMs = Date.parse(entry.ts);
    const previousTimeMs = latestOperationTimeByAccount.get(entry.accountId);
    if (previousTimeMs === undefined || operationTimeMs > previousTimeMs) {
      latestOperationTimeByAccount.set(entry.accountId, operationTimeMs);
    }
  }

  const latestCheckingEurOperation = page.entries.find((entry) => entry.accountId === "checking-eur");
  assert.equal(latestCheckingEurOperation?.kind, "transfer");

  const expected = activeAccounts
    .map((account) => {
      const latestOperationTimeMs = latestOperationTimeByAccount.get(account.accountId);
      if (latestOperationTimeMs === undefined) {
        throw new Error(`Missing demo ledger operation for account "${account.accountId}"`);
      }
      return {
        accountId: account.accountId,
        currency: account.currency,
        latestOperationTimeMs,
      };
    })
    .sort((left, right) => {
      const timeComparison = right.latestOperationTimeMs - left.latestOperationTimeMs;
      if (timeComparison !== 0) return timeComparison;
      return left.accountId < right.accountId ? -1 : left.accountId > right.accountId ? 1 : 0;
    })
    .map(({ accountId, currency }) => ({ accountId, currency }));

  assert.deepEqual(suggestions, expected);
  assert.deepEqual(
    [...suggestions].map(({ accountId }) => accountId).sort(),
    activeAccounts.map(({ accountId }) => accountId).sort(),
  );
});
