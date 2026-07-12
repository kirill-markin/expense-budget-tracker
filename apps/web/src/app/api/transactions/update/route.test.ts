import assert from "node:assert/strict";
import test from "node:test";

import { POST } from "@/app/api/transactions/update/route";

const updateBody = {
  entryId: "entry-123",
  category: "Software",
  note: "Monthly subscription",
  counterparty: "Example Cloud",
  kind: "spend",
  ts: "2026-07-12T09:30:00.000Z",
  accountId: "account-789",
  amount: -24.5,
  currency: "EUR",
} as const;

const createDemoUpdateRequest = (body: object): Request =>
  new Request("http://localhost/api/transactions/update", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: "demo=true",
    },
    body: JSON.stringify(body),
  });

test("Demo update accepts the legacy body without eventId", async (): Promise<void> => {
  const response = await POST(createDemoUpdateRequest(updateBody));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("Demo update accepts eventId and returns the complete updated ledger entry", async (): Promise<void> => {
  const response = await POST(createDemoUpdateRequest({
    ...updateBody,
    eventId: "event-456",
  }));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
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
  });
});
