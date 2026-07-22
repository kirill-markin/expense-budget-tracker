import assert from "node:assert/strict";
import test from "node:test";

import { DELETE, PATCH } from "@/app/api/budget-adjustments/[adjustmentId]/route";
import { POST } from "@/app/api/budget-adjustments/route";
import { GET as GET_BUDGET_GRID } from "@/app/api/budget-grid/route";
import { getCurrentMonth } from "@/lib/monthUtils";

const ADJUSTMENT_ID = "2df9496e-76f5-4db6-a4e6-11c7e588a4fb";

const postDemoAdjustment = async (
  body: Readonly<Record<string, unknown>>,
  sessionCookie: string | null,
): Promise<Response> =>
  POST(new Request("http://localhost/api/budget-adjustments", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `demo=true${sessionCookie === null ? "" : `; ${sessionCookie}`}`,
    },
    body: JSON.stringify(body),
  }));

const getSessionCookie = (response: Response): string => {
  const header = response.headers.get("set-cookie");
  assert.ok(header, "Expected demo adjustment session cookie");
  return header.split(";", 1)[0];
};

test("demo create uses the client ID and exact retries preserve the authoritative row", async (): Promise<void> => {
  const body = {
    adjustmentId: ADJUSTMENT_ID,
    month: getCurrentMonth(),
    direction: "spend",
    category: "Groceries",
    amount: 0,
    note: null,
  } as const;
  const response = await postDemoAdjustment(body, null);

  assert.equal(response.status, 200);
  const adjustment = await response.json() as Record<string, unknown>;
  assert.equal(adjustment.adjustmentId, ADJUSTMENT_ID);
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

  const lostResponseRetry = await postDemoAdjustment(body, null);
  assert.equal(lostResponseRetry.status, 200);
  assert.deepEqual(await lostResponseRetry.json(), adjustment);

  const sessionCookie = getSessionCookie(response);
  const retryResponse = await postDemoAdjustment(body, sessionCookie);
  assert.equal(retryResponse.status, 200);
  assert.deepEqual(await retryResponse.json(), adjustment);

  const conflictResponse = await postDemoAdjustment(
    { ...body, amount: 1 },
    sessionCookie,
  );
  assert.equal(conflictResponse.status, 409);
  assert.equal(
    await conflictResponse.text(),
    `Budget adjustment ID "${ADJUSTMENT_ID}" is already in use`,
  );
});

test("demo create rejects malformed client IDs", async (): Promise<void> => {
  const response = await postDemoAdjustment({
    adjustmentId: "not-a-uuid",
    month: getCurrentMonth(),
    direction: "income",
    category: "Bonus",
    amount: 0,
    note: null,
  }, null);

  assert.equal(response.status, 400);
  assert.match(await response.text(), /Expected UUID/);
});

test("demo session state follows create, range, patch, and delete across requests", async (): Promise<void> => {
  const adjustmentId = "bbdbb70a-c525-420c-bf01-97675a03d30b";
  const month = getCurrentMonth();
  const createdResponse = await postDemoAdjustment({
    adjustmentId,
    month,
    direction: "income",
    category: "Session bonus",
    amount: 5,
    note: null,
  }, null);
  const createdCookie = getSessionCookie(createdResponse);
  const gridUrl = `http://localhost/api/budget-grid?monthFrom=${month}&monthTo=${month}&planFrom=${month}&actualTo=${month}`;
  const createdGridResponse = await GET_BUDGET_GRID(new Request(gridUrl, {
    headers: { cookie: `demo=true; ${createdCookie}` },
  }));
  const createdGrid = await createdGridResponse.json() as {
    adjustments: ReadonlyArray<Record<string, unknown>>;
    rows: ReadonlyArray<Record<string, unknown>>;
  };
  assert.equal(
    createdGrid.adjustments.find((adjustment) =>
      adjustment.adjustmentId === adjustmentId)?.amount,
    5,
  );
  assert.equal(
    createdGrid.rows.find((row) => row.category === "Session bonus")?.plannedModifier,
    5,
  );

  const context = { params: Promise.resolve({ adjustmentId }) };
  const patchedResponse = await PATCH(new Request(
    `http://localhost/api/budget-adjustments/${adjustmentId}`,
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        cookie: `demo=true; ${createdCookie}`,
      },
      body: JSON.stringify({ amount: 9 }),
    },
  ), context);
  assert.equal(patchedResponse.status, 200);
  const patchedCookie = getSessionCookie(patchedResponse);
  const patchedGridResponse = await GET_BUDGET_GRID(new Request(gridUrl, {
    headers: { cookie: `demo=true; ${patchedCookie}` },
  }));
  const patchedGrid = await patchedGridResponse.json() as {
    adjustments: ReadonlyArray<Record<string, unknown>>;
  };
  assert.equal(
    patchedGrid.adjustments.find((adjustment) =>
      adjustment.adjustmentId === adjustmentId)?.amount,
    9,
  );

  const deletedResponse = await DELETE(new Request(
    `http://localhost/api/budget-adjustments/${adjustmentId}`,
    { method: "DELETE", headers: { cookie: `demo=true; ${patchedCookie}` } },
  ), context);
  assert.equal(deletedResponse.status, 200);
  const deletedCookie = getSessionCookie(deletedResponse);
  const deletedGridResponse = await GET_BUDGET_GRID(new Request(gridUrl, {
    headers: { cookie: `demo=true; ${deletedCookie}` },
  }));
  const deletedGrid = await deletedGridResponse.json() as {
    adjustments: ReadonlyArray<Record<string, unknown>>;
    rows: ReadonlyArray<Record<string, unknown>>;
  };
  assert.equal(deletedGrid.adjustments.some((adjustment) =>
    adjustment.adjustmentId === adjustmentId), false);
  assert.equal(deletedGrid.rows.some((row) => row.category === "Session bonus"), false);
});
