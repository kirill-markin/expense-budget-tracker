import assert from "node:assert/strict";
import test from "node:test";

import type { LedgerEntry } from "@/server/transactions/getTransactions";

import {
  isTransactionCopyAvailable,
  serializeTransactionClipboard,
  toTransactionClipboardPayload,
} from "./transactionClipboard";

test("toTransactionClipboardPayload maps every ledger value to stable snake_case keys", (): void => {
  const entry: LedgerEntry = {
    note: "Monthly subscription",
    currency: "EUR",
    eventId: "event-456",
    amountReport: -21.75,
    accountId: "account-789",
    category: "Software",
    entryId: "entry-123",
    counterparty: "Example Cloud",
    ts: "2026-07-12T09:30:00.000Z",
    kind: "spend",
    amount: -24.5,
  };

  const payload = toTransactionClipboardPayload(entry);

  assert.deepEqual(Object.keys(payload), [
    "entry_id",
    "event_id",
    "ts",
    "account_id",
    "amount",
    "amount_report",
    "currency",
    "kind",
    "category",
    "counterparty",
    "note",
  ]);
  assert.deepEqual(payload, {
    entry_id: "entry-123",
    event_id: "event-456",
    ts: "2026-07-12T09:30:00.000Z",
    account_id: "account-789",
    amount: -24.5,
    amount_report: -21.75,
    currency: "EUR",
    kind: "spend",
    category: "Software",
    counterparty: "Example Cloud",
    note: "Monthly subscription",
  });
});

test("serializeTransactionClipboard preserves nulls and returns deterministic readable JSON", (): void => {
  const entry: LedgerEntry = {
    entryId: "entry-nullable",
    eventId: "event-nullable",
    ts: "2026-01-02T03:04:05.000Z",
    accountId: "account-main",
    amount: -10,
    amountReport: null,
    currency: "USD",
    kind: "spend",
    category: null,
    counterparty: null,
    note: null,
  };

  assert.equal(
    serializeTransactionClipboard(entry),
    `{
  "entry_id": "entry-nullable",
  "event_id": "event-nullable",
  "ts": "2026-01-02T03:04:05.000Z",
  "account_id": "account-main",
  "amount": -10,
  "amount_report": null,
  "currency": "USD",
  "kind": "spend",
  "category": null,
  "counterparty": null,
  "note": null
}`,
  );
});

test("isTransactionCopyAvailable follows filtered visibility and pending-save state", (): void => {
  const entry: LedgerEntry = {
    entryId: "entry-visible",
    eventId: "event-visible",
    ts: "2026-07-12T09:30:00.000Z",
    accountId: "account-main",
    amount: -10,
    amountReport: -10,
    currency: "USD",
    kind: "spend",
    category: "Groceries",
    counterparty: null,
    note: null,
  };

  assert.equal(isTransactionCopyAvailable(entry, null, new Set()), true);
  assert.equal(isTransactionCopyAvailable(entry, new Set(["Groceries"]), new Set()), true);
  assert.equal(isTransactionCopyAvailable(entry, new Set(["Rent"]), new Set()), false);
  assert.equal(isTransactionCopyAvailable({ ...entry, category: null }, new Set(["Groceries"]), new Set()), false);
  assert.equal(isTransactionCopyAvailable(entry, null, new Set([entry.entryId])), false);
});
