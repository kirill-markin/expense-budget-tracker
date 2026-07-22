import assert from "node:assert/strict";
import test from "node:test";

import type { BudgetAdjustment } from "@/server/budget/budgetAdjustments";
import {
  readBudgetAdjustmentDeleteResponse,
  readBudgetAdjustmentResponse,
} from "@/ui/tables/budget/budgetTableApi";

const createAdjustment = (
  adjustmentId: string,
  category: string,
  amount: number,
  note: string | null,
): BudgetAdjustment => ({
  adjustmentId,
  month: "2026-07",
  direction: "spend",
  category,
  amount,
  note,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-02T00:00:00.000Z",
});

const assertInvalidAdjustmentResponse = async (payload: unknown): Promise<void> => {
  await assert.rejects(
    readBudgetAdjustmentResponse(Response.json(payload), "Invalid adjustment response"),
    /returned an invalid response/,
  );
};

test("budget adjustment responses accept contract boundaries measured by code point", async (): Promise<void> => {
  const boundaryAdjustment = createAdjustment(
    "\u{1F4B0}".repeat(200),
    "\u{1F600}".repeat(200),
    Number.MAX_SAFE_INTEGER,
    "\u{1F680}".repeat(2000),
  );

  assert.deepEqual(
    await readBudgetAdjustmentResponse(Response.json(boundaryAdjustment), "Boundary response"),
    boundaryAdjustment,
  );
  assert.equal(
    (await readBudgetAdjustmentResponse(
      Response.json({ ...boundaryAdjustment, amount: Number.MIN_SAFE_INTEGER, note: null }),
      "Minimum amount response",
    )).amount,
    Number.MIN_SAFE_INTEGER,
  );
});

test("budget adjustment responses enforce strict fields, string bounds, safe integers, and ISO dates", async (): Promise<void> => {
  const adjustment = createAdjustment("adjustment-1", "Groceries", 0, null);

  await assertInvalidAdjustmentResponse({ ...adjustment, adjustmentId: "" });
  await assertInvalidAdjustmentResponse({ ...adjustment, adjustmentId: "\u{1F4B0}".repeat(201) });
  await assertInvalidAdjustmentResponse({ ...adjustment, category: "" });
  await assertInvalidAdjustmentResponse({ ...adjustment, category: "\u{1F600}".repeat(201) });
  await assertInvalidAdjustmentResponse({ ...adjustment, note: "\u{1F680}".repeat(2001) });
  await assertInvalidAdjustmentResponse({ ...adjustment, amount: 0.5 });
  await assertInvalidAdjustmentResponse({ ...adjustment, amount: Number.MAX_SAFE_INTEGER + 1 });
  await assertInvalidAdjustmentResponse({ ...adjustment, createdAt: "2026-07-01" });
  await assertInvalidAdjustmentResponse({ ...adjustment, updatedAt: "not-a-date" });
  await assertInvalidAdjustmentResponse({ ...adjustment, unexpected: true });
});

test("budget adjustment responses reject errors and malformed JSON with response context", async (): Promise<void> => {
  await assert.rejects(
    readBudgetAdjustmentResponse(
      new Response("upstream unavailable", { status: 503 }),
      "Budget adjustment create",
    ),
    /Budget adjustment create failed: 503 upstream unavailable/,
  );
  await assert.rejects(
    readBudgetAdjustmentResponse(
      new Response("not-json", { status: 200 }),
      "Budget adjustment create",
    ),
    /Budget adjustment create returned invalid JSON:.*Response body: not-json/,
  );
});

test("budget adjustment delete responses distinguish deleted and already absent outcomes", async (): Promise<void> => {
  assert.equal(
    await readBudgetAdjustmentDeleteResponse(Response.json({ ok: true }), "deleted"),
    "deleted",
  );
  assert.equal(
    await readBudgetAdjustmentDeleteResponse(
      new Response("{\"error\":\"missing\"}", { status: 404 }),
      "lost-response",
    ),
    "already-absent",
  );
});

test("successful budget adjustment delete responses are strictly validated", async (): Promise<void> => {
  await assert.rejects(
    readBudgetAdjustmentDeleteResponse(Response.json({ ok: false }), "adjustment-1"),
    /returned an invalid response/,
  );
  await assert.rejects(
    readBudgetAdjustmentDeleteResponse(Response.json({ ok: true, unexpected: true }), "adjustment-1"),
    /returned an invalid response/,
  );
  await assert.rejects(
    readBudgetAdjustmentDeleteResponse(
      new Response("server error", { status: 500 }),
      "adjustment-1",
    ),
    /Budget adjustment adjustment-1 delete failed: 500 server error/,
  );
});
