import assert from "node:assert/strict";
import test from "node:test";

import { POST } from "@/app/api/transactions/create/route";
import type { LedgerEntry } from "@/server/transactions/getTransactions";

/** Every ledger field of the demo create response except the freshly minted identifiers. */
type StoredFields = Omit<LedgerEntry, "entryId" | "eventId">;

const createDemoCreateRequest = (body: object): Request =>
  new Request("http://localhost/api/transactions/create", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: "demo=true",
    },
    body: JSON.stringify(body),
  });

/** Asserts the freshly minted identifiers and returns the rest for exact comparison. */
const readStoredFields = async (response: Response): Promise<StoredFields> => {
  const entry: LedgerEntry = await response.json();
  const { entryId, eventId, ...storedFields } = entry;

  assert.equal(typeof entryId, "string");
  assert.ok(entryId.length > 0);
  assert.equal(typeof eventId, "string");
  assert.ok(eventId.length > 0);

  return storedFields;
};

test("Demo create returns the complete ledger entry of a spend", async (): Promise<void> => {
  const response = await POST(createDemoCreateRequest({
    ts: "2026-07-12T09:30:00.000Z",
    accountId: "account-789",
    amount: -24.5,
    currency: "EUR",
    kind: "spend",
    category: "Software",
    counterparty: "Example Cloud",
    note: "Monthly subscription",
  }));

  assert.equal(response.status, 200);
  const expected: StoredFields = {
    ts: "2026-07-12T09:30:00.000Z",
    accountId: "account-789",
    amount: -24.5,
    amountReport: -25.21,
    currency: "EUR",
    kind: "spend",
    category: "Software",
    counterparty: "Example Cloud",
    note: "Monthly subscription",
    isUnpairedTransfer: false,
  };
  assert.deepEqual(await readStoredFields(response), expected);
});

test("Demo create flags a transfer as unpaired because its event holds no second leg", async (): Promise<void> => {
  const response = await POST(createDemoCreateRequest({
    ts: "2026-08-01T12:00:00.000Z",
    accountId: "account-555",
    amount: -40,
    currency: "GBP",
    kind: "transfer",
    category: null,
    counterparty: null,
    note: null,
  }));

  assert.equal(response.status, 200);
  const expected: StoredFields = {
    ts: "2026-08-01T12:00:00.000Z",
    accountId: "account-555",
    amount: -40,
    amountReport: -49.6,
    currency: "GBP",
    kind: "transfer",
    category: null,
    counterparty: null,
    note: null,
    isUnpairedTransfer: true,
  };
  assert.deepEqual(await readStoredFields(response), expected);
});
