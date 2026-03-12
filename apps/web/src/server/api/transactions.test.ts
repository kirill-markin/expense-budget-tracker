import assert from "node:assert/strict";
import test from "node:test";

import { ApiRouteError } from "./errors";
import { parseTransactionsCreateBody, parseTransactionsDeleteBody, parseTransactionsFilterQuery, parseTransactionsUpdateBody } from "./transactions";

test("parseTransactionsFilterQuery applies explicit defaults", () => {
  const result = parseTransactionsFilterQuery(new URLSearchParams());

  assert.deepEqual(result, {
    dateFrom: null,
    dateTo: null,
    accountId: null,
    kind: null,
    category: null,
    categories: null,
    sortKey: "ts",
    sortDir: "desc",
    limit: 100,
    offset: 0,
  });
});

test("parseTransactionsFilterQuery rejects invalid limit", () => {
  assert.throws(
    (): void => {
      parseTransactionsFilterQuery(new URLSearchParams("limit=0"));
    },
    (error: unknown): boolean =>
      error instanceof ApiRouteError
      && error.publicMessage === "limit must be 1..500",
  );
});

test("parseTransactionsFilterQuery rejects invalid sortKey", () => {
  assert.throws(
    (): void => {
      parseTransactionsFilterQuery(new URLSearchParams("sortKey=foo"));
    },
    (error: unknown): boolean =>
      error instanceof ApiRouteError
      && error.publicMessage === "sortKey must be one of: ts, accountId, amount, amountAbs, amountUsdAbs, currency, kind, category, counterparty",
  );
});

test("parseTransactionsFilterQuery validates repeated categories entries", () => {
  assert.throws(
    (): void => {
      parseTransactionsFilterQuery(new URLSearchParams(`categories=${"x".repeat(201)}`));
    },
    (error: unknown): boolean =>
      error instanceof ApiRouteError
      && error.publicMessage === "categories entry too long (max 200 chars)",
  );
});

test("parseTransactionsCreateBody validates create payloads", () => {
  const result = parseTransactionsCreateBody({
    ts: "2026-03-12T10:00:00.000Z",
    accountId: "",
    amount: 10,
    currency: "USD",
    kind: "income",
    category: null,
    counterparty: null,
    note: null,
  });

  assert.equal(result.accountId, "");
  assert.equal(result.kind, "income");
});

test("parseTransactionsUpdateBody validates entryId and payload fields", () => {
  const result = parseTransactionsUpdateBody({
    entryId: "entry-1",
    ts: "2026-03-12T10:00:00.000Z",
    accountId: "cash",
    amount: 10,
    currency: "USD",
    kind: "transfer",
    category: "Move",
    counterparty: "Wallet",
    note: "memo",
  });

  assert.equal(result.entryId, "entry-1");
  assert.equal(result.kind, "transfer");
});

test("parseTransactionsDeleteBody validates entryId", () => {
  const result = parseTransactionsDeleteBody({ entryId: "entry-1" });

  assert.deepEqual(result, { entryId: "entry-1" });
});
