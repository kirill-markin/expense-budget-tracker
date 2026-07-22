import assert from "node:assert/strict";
import test from "node:test";

import { DELETE, PATCH } from "@/app/api/budget-adjustments/[adjustmentId]/route";

const context = {
  params: Promise.resolve({ adjustmentId: "demo-adjustment-groceries-seasonal" }),
};

test("demo patch returns the canonical seeded adjustment with the supplied change", async (): Promise<void> => {
  const response = await PATCH(new Request("http://localhost/api/budget-adjustments/demo-adjustment-groceries-seasonal", {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      cookie: "demo=true",
    },
    body: JSON.stringify({ note: "Updated note" }),
  }), context);

  assert.equal(response.status, 200);
  const adjustment = await response.json() as Record<string, unknown>;
  assert.equal(adjustment.adjustmentId, "demo-adjustment-groceries-seasonal");
  assert.equal(adjustment.direction, "spend");
  assert.equal(adjustment.category, "Groceries");
  assert.equal(adjustment.amount, 75);
  assert.equal(adjustment.note, "Updated note");
});

test("demo delete returns the delete contract", async (): Promise<void> => {
  const response = await DELETE(new Request("http://localhost/api/budget-adjustments/demo-adjustment-groceries-seasonal", {
    method: "DELETE",
    headers: { cookie: "demo=true" },
  }), context);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("demo patch and delete return 404 for an unknown adjustment", async (): Promise<void> => {
  const unknownContext = {
    params: Promise.resolve({ adjustmentId: "unknown-adjustment" }),
  };
  const patchResponse = await PATCH(new Request("http://localhost/api/budget-adjustments/unknown-adjustment", {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      cookie: "demo=true",
    },
    body: JSON.stringify({ amount: 1 }),
  }), unknownContext);
  const deleteResponse = await DELETE(new Request("http://localhost/api/budget-adjustments/unknown-adjustment", {
    method: "DELETE",
    headers: { cookie: "demo=true" },
  }), unknownContext);

  assert.equal(patchResponse.status, 404);
  assert.equal(deleteResponse.status, 404);
});
