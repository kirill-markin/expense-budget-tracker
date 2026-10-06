import assert from "node:assert/strict";
import test from "node:test";

import type { LedgerEntry } from "@/server/transactions/getTransactions";

import { computeUnpairedTransferRemarks } from "./unpairedTransferMarkers";

const makeEntry = (overrides: Partial<LedgerEntry>): LedgerEntry => ({
  entryId: "entry-123",
  eventId: "event-456",
  ts: "2026-07-12T09:30:00.000Z",
  accountId: "account-789",
  amount: -24.5,
  amountReport: -25.21,
  currency: "EUR",
  kind: "transfer",
  category: null,
  counterparty: null,
  note: null,
  isUnpairedTransfer: false,
  ...overrides,
});

test("marks the surviving leg unpaired once the other leg of the event is gone", (): void => {
  const survivor = makeEntry({ entryId: "leg-a" });
  const otherEvent = makeEntry({ entryId: "leg-x", eventId: "event-other" });

  assert.deepEqual(
    computeUnpairedTransferRemarks([survivor, otherEvent], "event-456", "leg-b"),
    [{ ...survivor, isUnpairedTransfer: true }],
  );
});

test("keeps both survivors paired when the event had three loaded legs", (): void => {
  const rows = [
    makeEntry({ entryId: "leg-a" }),
    makeEntry({ entryId: "leg-b" }),
  ];

  assert.deepEqual(computeUnpairedTransferRemarks(rows, "event-456", "leg-c"), []);
});

test("clears the marker of a sibling once a second transfer leg exists again", (): void => {
  const sibling = makeEntry({ entryId: "leg-a", isUnpairedTransfer: true });
  const mutated = makeEntry({ entryId: "leg-b" });

  assert.deepEqual(
    computeUnpairedTransferRemarks([sibling, mutated], "event-456", "leg-b"),
    [{ ...sibling, isUnpairedTransfer: false }],
  );
});

test("ignores a non-transfer sibling of the same event", (): void => {
  const leg = makeEntry({ entryId: "leg-a" });
  const spendSibling = makeEntry({ entryId: "leg-b", kind: "spend" });

  assert.deepEqual(
    computeUnpairedTransferRemarks([leg, spendSibling], "event-456", "leg-c"),
    [{ ...leg, isUnpairedTransfer: true }],
  );
});

test("never returns the mutated row itself", (): void => {
  const mutated = makeEntry({ entryId: "leg-a" });

  assert.deepEqual(
    computeUnpairedTransferRemarks([mutated], "event-456", "leg-a"),
    [],
  );
});

test("returns nothing when the loaded legs already carry the right marker", (): void => {
  const rows = [
    makeEntry({ entryId: "leg-a" }),
    makeEntry({ entryId: "leg-b" }),
    makeEntry({ entryId: "leg-x", eventId: "event-other", isUnpairedTransfer: true }),
  ];

  assert.deepEqual(computeUnpairedTransferRemarks(rows, "event-456", "leg-b"), []);
});
