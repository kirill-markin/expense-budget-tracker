import assert from "node:assert/strict";
import test from "node:test";

import type { BudgetAdjustment, CreateBudgetAdjustmentParams } from "@/server/budget/budgetAdjustments";
import {
  createBudgetAdjustment,
  deleteBudgetAdjustment,
  patchBudgetAdjustment,
  readBudgetAdjustmentCreateResponse,
  readBudgetAdjustmentDeleteResponse,
  readBudgetAdjustmentResponse,
  serializeBudgetAdjustmentCreateParams,
} from "@/ui/tables/budget/budgetTableApi";

const CREATE_PARAMS: CreateBudgetAdjustmentParams = {
  adjustmentId: "5bd6592b-45e8-4c25-b37e-72b96591f54a",
  month: "2026-07",
  direction: "spend",
  category: "Groceries",
  amount: 0,
  note: null,
};

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

test("budget adjustment create serialization includes the final UUID and only contract fields", (): void => {
  assert.deepEqual(JSON.parse(serializeBudgetAdjustmentCreateParams(CREATE_PARAMS)), CREATE_PARAMS);
  assert.throws(
    () => serializeBudgetAdjustmentCreateParams({
      ...CREATE_PARAMS,
      adjustmentId: "temporary-row-1",
    }),
    /must be a UUID/,
  );
});

test("budget adjustment create responses require the requested ID and direction", async (): Promise<void> => {
  const adjustment = createAdjustment(
    CREATE_PARAMS.adjustmentId,
    CREATE_PARAMS.category,
    CREATE_PARAMS.amount,
    CREATE_PARAMS.note,
  );
  assert.deepEqual(
    await readBudgetAdjustmentCreateResponse(Response.json(adjustment), CREATE_PARAMS),
    adjustment,
  );
  await assert.rejects(
    readBudgetAdjustmentCreateResponse(
      Response.json({ ...adjustment, adjustmentId: "73838d3d-bdce-41a4-ac3e-60349776ca55" }),
      CREATE_PARAMS,
    ),
    /does not match requested id/,
  );
  await assert.rejects(
    readBudgetAdjustmentCreateResponse(
      Response.json({ ...adjustment, direction: "income" }),
      CREATE_PARAMS,
    ),
    /changed immutable direction/,
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

test("demo create, patch, and delete wait for the same cross-tab Web Lock", async (): Promise<void> => {
  type PendingFetch = Readonly<{
    input: RequestInfo | URL;
    init: RequestInit | undefined;
    resolve: (response: Response) => void;
  }>;
  type PendingLock = Readonly<{
    name: string;
    acquire: () => void;
  }>;

  const originalFetch = globalThis.fetch;
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const pending: Array<PendingFetch> = [];
  const pendingLocks: Array<PendingLock> = [];
  const requirePendingFetch = (index: number): PendingFetch => {
    const request = pending[index];
    assert.ok(request, `Expected pending fetch ${index}`);
    return request;
  };
  const acquirePendingLock = (index: number): void => {
    const lock = pendingLocks[index];
    assert.ok(lock, `Expected pending Web Lock ${index}`);
    lock.acquire();
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "__Host-csrf=test-token; demo=true" },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      locks: {
        request: <T>(name: string, callback: () => Promise<T>): Promise<T> =>
          new Promise<T>((resolve, reject): void => {
            pendingLocks.push({
              name,
              acquire: (): void => {
                void callback().then(resolve, reject);
              },
            });
          }),
      },
    },
  });
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    new Promise((resolve): void => {
      pending.push({ input, init, resolve });
    })) as typeof fetch;

  try {
    const createPromise = createBudgetAdjustment(CREATE_PARAMS);
    const patchPromise = patchBudgetAdjustment(CREATE_PARAMS.adjustmentId, { amount: 7 });
    const deletePromise = deleteBudgetAdjustment(CREATE_PARAMS.adjustmentId);

    assert.deepEqual(
      pendingLocks.map((lock) => lock.name),
      [
        "demo-budget-adjustment-session-cookie-mutation",
        "demo-budget-adjustment-session-cookie-mutation",
        "demo-budget-adjustment-session-cookie-mutation",
      ],
    );
    assert.equal(pending.length, 0);
    acquirePendingLock(0);
    assert.equal(pending.length, 1);
    const createRequest = requirePendingFetch(0);
    assert.equal(String(createRequest.input), "/api/budget-adjustments");
    assert.equal(createRequest.init?.method, "POST");
    createRequest.resolve(Response.json(createAdjustment(
      CREATE_PARAMS.adjustmentId,
      CREATE_PARAMS.category,
      CREATE_PARAMS.amount,
      CREATE_PARAMS.note,
    )));
    await createPromise;

    acquirePendingLock(1);
    assert.equal(pending.length, 2);
    const patchRequest = requirePendingFetch(1);
    assert.equal(
      String(patchRequest.input),
      `/api/budget-adjustments/${CREATE_PARAMS.adjustmentId}`,
    );
    assert.equal(patchRequest.init?.method, "PATCH");
    patchRequest.resolve(Response.json(createAdjustment(
      CREATE_PARAMS.adjustmentId,
      CREATE_PARAMS.category,
      7,
      CREATE_PARAMS.note,
    )));
    assert.equal((await patchPromise).amount, 7);

    acquirePendingLock(2);
    assert.equal(pending.length, 3);
    const deleteRequest = requirePendingFetch(2);
    assert.equal(
      String(deleteRequest.input),
      `/api/budget-adjustments/${CREATE_PARAMS.adjustmentId}`,
    );
    assert.equal(deleteRequest.init?.method, "DELETE");
    deleteRequest.resolve(Response.json({ ok: true }));
    assert.equal(await deletePromise, "deleted");

    document.cookie = "__Host-csrf=test-token";
    const nonDemoCreatePromise = createBudgetAdjustment(CREATE_PARAMS);
    const nonDemoPatchPromise = patchBudgetAdjustment(CREATE_PARAMS.adjustmentId, { amount: 8 });
    const nonDemoDeletePromise = deleteBudgetAdjustment(CREATE_PARAMS.adjustmentId);
    assert.equal(pendingLocks.length, 3);
    assert.equal(pending.length, 6);
    requirePendingFetch(3).resolve(Response.json(createAdjustment(
      CREATE_PARAMS.adjustmentId,
      CREATE_PARAMS.category,
      CREATE_PARAMS.amount,
      CREATE_PARAMS.note,
    )));
    requirePendingFetch(4).resolve(Response.json(createAdjustment(
      CREATE_PARAMS.adjustmentId,
      CREATE_PARAMS.category,
      8,
      CREATE_PARAMS.note,
    )));
    requirePendingFetch(5).resolve(Response.json({ ok: true }));
    await Promise.all([
      nonDemoCreatePromise,
      nonDemoPatchPromise,
      nonDemoDeletePromise,
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    if (documentDescriptor === undefined) {
      Reflect.deleteProperty(globalThis, "document");
    } else {
      Object.defineProperty(globalThis, "document", documentDescriptor);
    }
    if (navigatorDescriptor === undefined) {
      Reflect.deleteProperty(globalThis, "navigator");
    } else {
      Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    }
  }
});

test("demo mutations fail explicitly when Web Locks are unavailable", async (): Promise<void> => {
  const originalFetch = globalThis.fetch;
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let fetchCalled = false;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { cookie: "__Host-csrf=test-token; demo=true" },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {},
  });
  globalThis.fetch = ((): Promise<Response> => {
    fetchCalled = true;
    return Promise.reject(new Error("Unexpected fetch"));
  }) as typeof fetch;

  try {
    await assert.rejects(
      createBudgetAdjustment(CREATE_PARAMS),
      /does not support the Web Locks API required to serialize changes across tabs/,
    );
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (documentDescriptor === undefined) {
      Reflect.deleteProperty(globalThis, "document");
    } else {
      Object.defineProperty(globalThis, "document", documentDescriptor);
    }
    if (navigatorDescriptor === undefined) {
      Reflect.deleteProperty(globalThis, "navigator");
    } else {
      Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    }
  }
});
