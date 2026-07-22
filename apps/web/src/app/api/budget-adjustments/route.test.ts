import assert from "node:assert/strict";
import test from "node:test";

import { POST } from "@/app/api/budget-adjustments/route";
import { getCurrentMonth } from "@/lib/monthUtils";

test("demo create returns a contract-shaped zero adjustment without identity headers", async (): Promise<void> => {
  const response = await POST(new Request("http://localhost/api/budget-adjustments", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: "demo=true",
    },
    body: JSON.stringify({
      month: getCurrentMonth(),
      direction: "spend",
      category: "Groceries",
      amount: 0,
      note: null,
    }),
  }));

  assert.equal(response.status, 200);
  const adjustment = await response.json() as Record<string, unknown>;
  assert.match(adjustment.adjustmentId as string, /^demo-created-spend-/);
  assert.equal(adjustment.month, getCurrentMonth());
  assert.equal(adjustment.direction, "spend");
  assert.equal(adjustment.category, "Groceries");
  assert.equal(adjustment.amount, 0);
  assert.equal(adjustment.note, null);
  assert.equal(typeof adjustment.createdAt, "string");
  assert.equal(typeof adjustment.updatedAt, "string");
  assert.deepEqual(Object.keys(adjustment).sort(), [
    "adjustmentId",
    "amount",
    "category",
    "createdAt",
    "direction",
    "month",
    "note",
    "updatedAt",
  ]);
});
