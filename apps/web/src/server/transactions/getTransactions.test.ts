import assert from "node:assert/strict";
import test from "node:test";

import { mapLedgerEntryRow, type LedgerEntryRow } from "@/server/transactions/getTransactions";

test("mapLedgerEntryRow maps the authoritative database event and recalculated report amount", (): void => {
  const row: LedgerEntryRow = {
    entry_id: "entry-database",
    event_id: "event-database",
    ts: "2026-07-12 09:30:00+00",
    account_id: "account-database",
    amount: -24.5,
    amount_report: -25.2105,
    currency: "EUR",
    kind: "spend",
    category: "Software",
    counterparty: "Example Cloud",
    note: "Monthly subscription",
  };

  assert.deepEqual(mapLedgerEntryRow(row), {
    entryId: "entry-database",
    eventId: "event-database",
    ts: "2026-07-12T09:30:00.000Z",
    accountId: "account-database",
    amount: -24.5,
    amountReport: -25.2105,
    currency: "EUR",
    kind: "spend",
    category: "Software",
    counterparty: "Example Cloud",
    note: "Monthly subscription",
  });
});
