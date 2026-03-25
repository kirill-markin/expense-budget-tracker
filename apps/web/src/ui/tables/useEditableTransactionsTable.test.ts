import assert from "node:assert/strict";
import test from "node:test";

import type { LedgerEntry } from "@/server/transactions/getTransactions";

import {
  buildDrillDownCreateEntryRequest,
  buildDrillDownPageUrl,
  buildTransactionsCreateEntryRequest,
  buildTransactionsPageUrl,
  mergeLedgerEntries,
  prependLedgerEntry,
  removeLedgerEntry,
  replaceLedgerEntry,
  type DrillDownFilter,
} from "./useEditableTransactionsTable";

const createEntry = (entryId: string, category: string | null): LedgerEntry => ({
  entryId,
  eventId: `event-${entryId}`,
  ts: "2026-03-12T10:00:00.000Z",
  accountId: "cash",
  amount: 10,
  amountUsd: 10,
  currency: "USD",
  kind: "spend",
  category,
  counterparty: null,
  note: null,
});

test("mergeLedgerEntries keeps created rows first and de-duplicates by entry id", () => {
  const createdRows = [createEntry("created", "Food"), createEntry("shared", "New")];
  const fetchedRows = [createEntry("shared", "Old"), createEntry("fetched", "Bills")];

  assert.deepEqual(mergeLedgerEntries(createdRows, fetchedRows), [
    createEntry("created", "Food"),
    createEntry("shared", "New"),
    createEntry("fetched", "Bills"),
  ]);
});

test("replaceLedgerEntry updates the matching row only", () => {
  const rows = [createEntry("a", "Food"), createEntry("b", "Bills")];
  const updated = { ...createEntry("b", "Travel"), note: "updated" };

  assert.deepEqual(replaceLedgerEntry(rows, updated), [
    createEntry("a", "Food"),
    updated,
  ]);
});

test("removeLedgerEntry removes only the selected row", () => {
  const rows = [createEntry("a", "Food"), createEntry("b", "Bills")];

  assert.deepEqual(removeLedgerEntry(rows, "a"), [createEntry("b", "Bills")]);
});

test("prependLedgerEntry inserts new rows at the front and replaces duplicates", () => {
  const rows = [createEntry("a", "Food"), createEntry("b", "Bills")];
  const updated = createEntry("b", "Travel");

  assert.deepEqual(prependLedgerEntry(rows, updated), [
    updated,
    createEntry("a", "Food"),
  ]);
});

test("buildTransactionsPageUrl preserves current optional filters and paging", () => {
  assert.equal(
    buildTransactionsPageUrl("2026-01-01", "2026-01-31", "cash", "ts", "desc", "refresh-1", 100, 200),
    "/api/transactions?dateFrom=2026-01-01&dateTo=2026-01-31&accountId=cash&sortKey=ts&sortDir=desc&limit=100&offset=200&refresh=refresh-1",
  );
  assert.equal(
    buildTransactionsPageUrl("", "", "", "amount", "asc", "refresh-2", 50, 0),
    "/api/transactions?sortKey=amount&sortDir=asc&limit=50&offset=0&refresh=refresh-2",
  );
});

test("buildTransactionsPageUrl changes when refreshToken changes", () => {
  assert.notEqual(
    buildTransactionsPageUrl("2026-01-01", "2026-01-31", "cash", "ts", "desc", "refresh-a", 100, 0),
    buildTransactionsPageUrl("2026-01-01", "2026-01-31", "cash", "ts", "desc", "refresh-b", 100, 0),
  );
});

test("buildTransactionsCreateEntryRequest keeps the transactions page defaults", () => {
  const result = buildTransactionsCreateEntryRequest("2026-03-12", "wallet");

  assert.deepEqual(result, {
    ts: new Date("2026-03-12T12:00").toISOString(),
    accountId: "wallet",
    amount: 0,
    currency: "",
    kind: "spend",
    category: null,
    counterparty: null,
    note: null,
  });
});

test("buildDrillDownPageUrl preserves drill-down filters including repeated categories", () => {
  const filter: DrillDownFilter = {
    dateFrom: "2026-03-01",
    dateTo: "2026-03-31",
    direction: "spend",
    category: "Food",
    categories: ["Food", ""],
  };

  assert.equal(
    buildDrillDownPageUrl(filter, "amountUsdAbs", "desc", "refresh-3", 100, 0),
    "/api/transactions?dateFrom=2026-03-01&dateTo=2026-03-31&kind=spend&category=Food&categories=Food&categories=&sortKey=amountUsdAbs&sortDir=desc&limit=100&offset=0&refresh=refresh-3",
  );
});

test("buildDrillDownPageUrl changes when refreshToken changes", () => {
  const filter: DrillDownFilter = {
    dateFrom: "2026-03-01",
    dateTo: "2026-03-31",
    direction: "spend",
    category: "Food",
    categories: null,
  };

  assert.notEqual(
    buildDrillDownPageUrl(filter, "amountUsdAbs", "desc", "refresh-a", 100, 0),
    buildDrillDownPageUrl(filter, "amountUsdAbs", "desc", "refresh-b", 100, 0),
  );
});

test("buildDrillDownCreateEntryRequest maps uncategorized drill-downs back to null", () => {
  const uncategorizedFilter: DrillDownFilter = {
    dateFrom: "2026-03-01",
    dateTo: "2026-03-31",
    direction: null,
    category: "",
    categories: null,
  };

  assert.deepEqual(buildDrillDownCreateEntryRequest(uncategorizedFilter), {
    ts: new Date("2026-03-31T12:00").toISOString(),
    accountId: "",
    amount: 0,
    currency: "",
    kind: "spend",
    category: null,
    counterparty: null,
    note: null,
  });
});
