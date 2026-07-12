import assert from "node:assert/strict";
import test from "node:test";

import type { LedgerEntry } from "@/server/transactions/getTransactions";

import {
  acceptTransactionSave,
  createAuthoritativeRowOverride,
  enqueueTransactionSave,
  parseLedgerEntryResponse,
  readLedgerEntryUpdateResponse,
  reconcileDisplayedLedgerEntries,
  rejectTransactionSave,
  startTransactionSave,
} from "./transactionSaveQueue";
import {
  isTransactionCopyAvailable,
  toTransactionClipboardPayload,
} from "../transactionClipboard";

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
}>;

const createDeferred = <T,>(): Deferred<T> => {
  let resolvePromise: (value: T) => void = (): void => {
    throw new Error("Deferred resolver was used before initialization");
  };
  const promise = new Promise<T>((resolve): void => {
    resolvePromise = resolve;
  });
  return { promise, resolve: (value: T): void => resolvePromise(value) };
};

const makeEntry = (overrides: Partial<LedgerEntry>): LedgerEntry => ({
  entryId: "entry-123",
  eventId: "event-456",
  ts: "2026-07-12T09:30:00.000Z",
  accountId: "account-789",
  amount: -24.5,
  amountReport: -25.21,
  currency: "EUR",
  kind: "spend",
  category: "Software",
  counterparty: "Example Cloud",
  note: "Monthly subscription",
  ...overrides,
});

test("parseLedgerEntryResponse validates and returns a complete authoritative row", (): void => {
  const response = makeEntry({ amount: -30, amountReport: -30.87 });

  assert.deepEqual(
    parseLedgerEntryResponse(response, response.entryId, response.eventId),
    response,
  );
});

test("parseLedgerEntryResponse rejects incomplete and mismatched update responses", (): void => {
  const response = makeEntry({ amountReport: -30.87 });
  const { amountReport: omittedAmountReport, ...incomplete } = response;
  void omittedAmountReport;

  assert.throws(
    () => parseLedgerEntryResponse(incomplete, response.entryId, response.eventId),
    /invalid ledger entry response \(amountReport:/,
  );
  assert.throws(
    () => parseLedgerEntryResponse({ ...response, entryId: "wrong-entry" }, response.entryId, response.eventId),
    /response entryId was wrong-entry/,
  );
  assert.throws(
    () => parseLedgerEntryResponse({ ...response, eventId: "wrong-event" }, response.entryId, response.eventId),
    /response eventId was wrong-event, expected event-456/,
  );
});

test("readLedgerEntryUpdateResponse rejects invalid JSON with entry and response context", async (): Promise<void> => {
  const entry = makeEntry({});
  const response = new Response("not-json", { status: 200 });

  await assert.rejects(
    readLedgerEntryUpdateResponse(response, entry),
    /Update failed for entry entry-123: response status 200 was not valid JSON.*body: not-json/,
  );
});

test("save transitions serialize edits and retain the newest optimistic row until the queue drains", (): void => {
  const original = makeEntry({ amount: -24.5, amountReport: -25.21 });
  const firstEdit = makeEntry({ amount: -30, amountReport: -25.21 });
  const secondEdit = makeEntry({ amount: -40, amountReport: -25.21, note: "Newest edit" });
  const firstAuthoritative = makeEntry({ amount: -30, amountReport: -30.87 });
  const finalAuthoritative = makeEntry({ amount: -40, amountReport: -41.16, note: "Newest edit" });

  const queued = enqueueTransactionSave(
    startTransactionSave(original, firstEdit),
    secondEdit,
  );

  assert.equal(queued.active, firstEdit);
  assert.deepEqual(queued.queued, [secondEdit]);

  const firstAccepted = acceptTransactionSave(queued, firstAuthoritative);
  assert.equal(firstAccepted.status, "continue");
  if (firstAccepted.status !== "continue") {
    throw new Error("Expected another queued save");
  }
  assert.equal(firstAccepted.row, secondEdit);
  assert.equal(firstAccepted.state.active, secondEdit);
  assert.equal(firstAccepted.state.authoritative, firstAuthoritative);

  const finalAccepted = acceptTransactionSave(firstAccepted.state, finalAuthoritative);
  assert.deepEqual(finalAccepted, { status: "complete", row: finalAuthoritative });
});

test("a failed chain cancels queued work and rolls back to the last successful authoritative row", (): void => {
  const original = makeEntry({ amount: -24.5, amountReport: -25.21 });
  const firstEdit = makeEntry({ amount: -30, amountReport: -25.21 });
  const secondEdit = makeEntry({ amount: -40, amountReport: -25.21 });
  const thirdEdit = makeEntry({ amount: -50, amountReport: -25.21 });
  const firstAuthoritative = makeEntry({ amount: -30, amountReport: -30.87 });

  const initialState = enqueueTransactionSave(
    enqueueTransactionSave(startTransactionSave(original, firstEdit), secondEdit),
    thirdEdit,
  );
  const firstAccepted = acceptTransactionSave(initialState, firstAuthoritative);
  if (firstAccepted.status !== "continue") {
    throw new Error("Expected queued saves after the first response");
  }

  assert.equal(firstAccepted.state.active, secondEdit);
  assert.deepEqual(firstAccepted.state.queued, [thirdEdit]);
  assert.equal(rejectTransactionSave(firstAccepted.state), firstAuthoritative);
  assert.equal(rejectTransactionSave(startTransactionSave(original, firstEdit)), original);
});

test("a stale refetch preserves the latest optimistic row used by a subsequent queued edit", (): void => {
  const original = makeEntry({ amount: -24.5, amountReport: -25.21, note: "Original" });
  const firstEdit = makeEntry({ amount: -30, amountReport: -25.21, note: "Original" });
  const saveState = startTransactionSave(original, firstEdit);

  const reconciled = reconcileDisplayedLedgerEntries(
    [original],
    (): number => 1,
    new Map([[original.entryId, saveState]]),
    new Map(),
  );
  assert.equal(reconciled.rows[0], firstEdit);

  const secondEdit = { ...reconciled.rows[0], note: "Second edit" };
  const queued = enqueueTransactionSave(saveState, secondEdit);
  assert.equal(queued.queued[0]?.amount, -30);
  assert.equal(queued.queued[0]?.note, "Second edit");
});

test("an authoritative response survives row absence and an older stale refetch as the copy source", (): void => {
  const stale = makeEntry({ amount: -24.5, amountReport: -25.21 });
  const authoritative = makeEntry({ amount: -30, amountReport: -30.87 });
  const authoritativeOverride = createAuthoritativeRowOverride(authoritative, 4);
  const overrides = new Map([[authoritative.entryId, authoritativeOverride]]);

  const absent = reconcileDisplayedLedgerEntries([], (): number => 4, new Map(), overrides);
  assert.equal(absent.rows.length, 0);
  assert.equal(absent.overrideRetirements.length, 0);

  const staleReturn = reconcileDisplayedLedgerEntries(
    [stale],
    (): number => 4,
    new Map(),
    overrides,
  );
  const copyRow = staleReturn.rows[0];
  if (copyRow === undefined) {
    throw new Error("Expected the refetched transaction row");
  }
  assert.equal(copyRow, authoritative);
  assert.equal(isTransactionCopyAvailable(copyRow, null, new Set()), true);
  assert.deepEqual(toTransactionClipboardPayload(copyRow), {
    entry_id: authoritative.entryId,
    event_id: authoritative.eventId,
    ts: authoritative.ts,
    account_id: authoritative.accountId,
    amount: -30,
    amount_report: -30.87,
    currency: authoritative.currency,
    kind: authoritative.kind,
    category: authoritative.category,
    counterparty: authoritative.counterparty,
    note: authoritative.note,
  });
});

test("a later matching fetch retires a temporary authoritative override", (): void => {
  const authoritative = makeEntry({ amount: -30, amountReport: -30.87 });
  const newerFetched = makeEntry({ amount: -35, amountReport: -36.02 });
  const overrides = new Map([
    [authoritative.entryId, createAuthoritativeRowOverride(authoritative, 4)],
  ]);

  const reconciled = reconcileDisplayedLedgerEntries(
    [newerFetched],
    (): number => 5,
    new Map(),
    overrides,
  );

  assert.equal(reconciled.rows[0], newerFetched);
  assert.deepEqual(reconciled.overrideRetirements, [{
    entryId: authoritative.entryId,
    override: overrides.get(authoritative.entryId),
  }]);
  assert.equal(overrides.has(authoritative.entryId), true);
});

test("display reconciliation defeats a captured optimistic fetch after authoritative acceptance", async (): Promise<void> => {
  const optimistic = makeEntry({ amount: -30, amountReport: -25.21 });
  const authoritative = makeEntry({ amount: -30, amountReport: -30.87 });
  const capturedFetch = createDeferred<ReadonlyArray<LedgerEntry>>();
  capturedFetch.resolve([optimistic]);
  const capturedRows = await capturedFetch.promise;

  const override = createAuthoritativeRowOverride(authoritative, 1);
  const displayed = reconcileDisplayedLedgerEntries(
    capturedRows,
    (): number => 1,
    new Map(),
    new Map([[authoritative.entryId, override]]),
  );

  assert.equal(displayed.rows[0], authoritative);
  assert.equal(isTransactionCopyAvailable(authoritative, null, new Set()), true);
  assert.equal(toTransactionClipboardPayload(displayed.rows[0] ?? optimistic).amount_report, -30.87);
});

test("display reconciliation defeats a captured optimistic fetch after rollback acceptance", async (): Promise<void> => {
  const capturedOptimistic = makeEntry({ amount: -40, amountReport: -30.87, note: "Queued edit" });
  const rollback = makeEntry({ amount: -30, amountReport: -30.87, note: "Accepted edit" });
  const capturedFetch = createDeferred<ReadonlyArray<LedgerEntry>>();
  capturedFetch.resolve([capturedOptimistic]);
  const capturedRows = await capturedFetch.promise;

  const override = createAuthoritativeRowOverride(rollback, 2);
  const displayed = reconcileDisplayedLedgerEntries(
    capturedRows,
    (): number => 2,
    new Map(),
    new Map([[rollback.entryId, override]]),
  );

  assert.equal(displayed.rows[0], rollback);
  assert.equal(isTransactionCopyAvailable(rollback, null, new Set()), true);
  assert.deepEqual(toTransactionClipboardPayload(displayed.rows[0] ?? capturedOptimistic), {
    entry_id: rollback.entryId,
    event_id: rollback.eventId,
    ts: rollback.ts,
    account_id: rollback.accountId,
    amount: -30,
    amount_report: -30.87,
    currency: rollback.currency,
    kind: rollback.kind,
    category: rollback.category,
    counterparty: rollback.counterparty,
    note: "Accepted edit",
  });
});
