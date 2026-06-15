import assert from "node:assert/strict";
import test from "node:test";

import {
  getPublicMonthlyShareRouteWithDeps,
  OPTIONS,
} from "@/app/api/share/monthly/[token]/route";
import type { PublicMonthlyCategoryShare } from "@/server/community/publicMonthlyCategoryShareTypes";

const SHARE: PublicMonthlyCategoryShare = {
  label: "Shared spend",
  currency: "USD",
  availableMonthFrom: "2025-01",
  availableMonthTo: "2025-12",
  loadedMonthFrom: "2025-03",
  loadedMonthTo: "2025-04",
  categories: [
    { category: "Groceries", accessLevel: "monthly_values" },
    { category: "Travel", accessLevel: "category_only" },
  ],
  cells: [
    { month: "2025-03", category: "Groceries", amount: 120.5 },
  ],
  yearTotals: [
    { year: "2025", category: "Groceries", amount: 120.5 },
  ],
};

const PUBLIC_SHARE_TOP_LEVEL_KEYS: ReadonlyArray<keyof PublicMonthlyCategoryShare> = [
  "label",
  "currency",
  "availableMonthFrom",
  "availableMonthTo",
  "loadedMonthFrom",
  "loadedMonthTo",
  "categories",
  "cells",
  "yearTotals",
];

const PRIVATE_FIELD_NAMES: ReadonlyArray<string> = [
  "workspaceId",
  "userId",
  "email",
  "entry_id",
  "event_id",
  "account_id",
  "counterparty",
  "note",
  "ts",
  "inserted_at",
  "budget",
  "planned",
  "plannedValue",
  "hasUnconvertible",
];

const createContext = (token: string): { params: Promise<{ token: string }> } => ({
  params: Promise.resolve({ token }),
});

const createGetRequest = (query: string): Request =>
  new Request(`http://localhost/api/share/monthly/token-1${query}`, { method: "GET" });

const assertPublicShareHeaders = (response: Response): void => {
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
};

const collectObjectKeys = (input: unknown): ReadonlyArray<string> => {
  const keys: Array<string> = [];

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    if (typeof value !== "object" || value === null) {
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      keys.push(key);
      visit(child);
    }
  };

  visit(input);
  return keys;
};

test("getPublicMonthlyShareRouteWithDeps returns public JSON with CORS and no-store headers", async (): Promise<void> => {
  const calls: Array<Readonly<{ token: string; monthFrom: string; monthTo: string }>> = [];
  const response = await getPublicMonthlyShareRouteWithDeps(
    createGetRequest("?monthFrom=2024-01&monthTo=2026-12"),
    createContext("token-1"),
    {
      getPublicMonthlyCategoryShare: async (token: string, monthFrom: string, monthTo: string): Promise<PublicMonthlyCategoryShare | null> => {
        calls.push({ token, monthFrom, monthTo });
        return SHARE;
      },
    },
  );

  assert.equal(response.status, 200);
  assertPublicShareHeaders(response);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  assert.deepEqual(calls, [{ token: "token-1", monthFrom: "2024-01", monthTo: "2025-12" }]);
  assert.deepEqual(await response.json(), SHARE);
});

test("getPublicMonthlyShareRouteWithDeps projects JSON to the public contract only", async (): Promise<void> => {
  const leakyShare = {
    ...SHARE,
    workspaceId: "workspace-private",
    userId: "user-private",
    email: "user@example.com",
    categories: [
      { category: "Groceries", accessLevel: "monthly_values", workspaceId: "workspace-private" },
      { category: "Travel", accessLevel: "category_only", userId: "user-private" },
    ],
    cells: [
      {
        month: "2025-03",
        category: "Groceries",
        amount: 120.5,
        entry_id: "entry-private",
        event_id: "event-private",
        account_id: "account-private",
        counterparty: "Private Store",
        note: "private note",
        ts: "2025-03-02T12:34:56.000Z",
        hasUnconvertible: true,
      },
    ],
    yearTotals: [
      {
        year: "2025",
        category: "Groceries",
        amount: 500,
        plannedValue: 900,
      },
    ],
  } as unknown as PublicMonthlyCategoryShare;

  const response = await getPublicMonthlyShareRouteWithDeps(
    createGetRequest("?monthFrom=2025-03&monthTo=2025-04"),
    createContext("token-1"),
    {
      getPublicMonthlyCategoryShare: async (): Promise<PublicMonthlyCategoryShare | null> => leakyShare,
    },
  );
  const body = await response.json() as PublicMonthlyCategoryShare;
  const keys = collectObjectKeys(body);

  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(body), PUBLIC_SHARE_TOP_LEVEL_KEYS);
  for (const privateField of PRIVATE_FIELD_NAMES) {
    assert.equal(keys.includes(privateField), false, `Unexpected private public-share field: ${privateField}`);
  }
  assert.deepEqual(body.categories, SHARE.categories);
  assert.deepEqual(body.cells, SHARE.cells);
  assert.deepEqual(body.yearTotals, [{ year: "2025", category: "Groceries", amount: 500 }]);
});

test("getPublicMonthlyShareRouteWithDeps returns an enabled empty public share", async (): Promise<void> => {
  const emptyShare: PublicMonthlyCategoryShare = {
    ...SHARE,
    categories: [],
    cells: [],
    yearTotals: [],
  };
  const response = await getPublicMonthlyShareRouteWithDeps(
    createGetRequest("?monthFrom=2025-03&monthTo=2025-04"),
    createContext("token-1"),
    {
      getPublicMonthlyCategoryShare: async (): Promise<PublicMonthlyCategoryShare | null> => emptyShare,
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), emptyShare);
});

test("getPublicMonthlyShareRouteWithDeps uses a bounded latest window when query params are omitted", async (): Promise<void> => {
  const calls: Array<Readonly<{ token: string; monthFrom: string; monthTo: string }>> = [];
  const response = await getPublicMonthlyShareRouteWithDeps(
    createGetRequest(""),
    createContext("token-1"),
    {
      getPublicMonthlyCategoryShare: async (token: string, monthFrom: string, monthTo: string): Promise<PublicMonthlyCategoryShare | null> => {
        calls.push({ token, monthFrom, monthTo });
        return SHARE;
      },
    },
  );

  assert.equal(response.status, 200);
  assertPublicShareHeaders(response);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].token, "token-1");
  assert.deepEqual(calls[1], { token: "token-1", monthFrom: "2025-01", monthTo: "2025-12" });
  assert.deepEqual(await response.json(), SHARE);
});

test("getPublicMonthlyShareRouteWithDeps returns equivalent 404 responses for every missing-token state", async (): Promise<void> => {
  const dependencies = {
    getPublicMonthlyCategoryShare: async (): Promise<PublicMonthlyCategoryShare | null> => null,
  };
  const tokenStates: ReadonlyArray<string> = [
    "invalid-token",
    "disabled-token",
    "revoked-token",
    "blocked-token",
    "unknown-token",
  ];
  const responses: Array<Readonly<{ status: number; text: string }>> = [];

  for (const token of tokenStates) {
    const response = await getPublicMonthlyShareRouteWithDeps(
      createGetRequest("?monthFrom=2025-03&monthTo=2025-04"),
      createContext(token),
      dependencies,
    );
    assertPublicShareHeaders(response);
    responses.push({ status: response.status, text: await response.text() });
  }

  assert.deepEqual(
    responses,
    tokenStates.map(() => ({
      status: 404,
      text: "{\"error\":\"Public monthly share not found\"}",
    })),
  );
});

test("getPublicMonthlyShareRouteWithDeps rejects invalid month queries before data access", async (): Promise<void> => {
  let callCount = 0;
  const response = await getPublicMonthlyShareRouteWithDeps(
    createGetRequest("?monthFrom=2025-13&monthTo=2025-04"),
    createContext("token-1"),
    {
      getPublicMonthlyCategoryShare: async (): Promise<PublicMonthlyCategoryShare | null> => {
        callCount++;
        return SHARE;
      },
    },
  );

  assert.equal(response.status, 400);
  assertPublicShareHeaders(response);
  assert.deepEqual(await response.json(), { error: "Invalid month format. Expected YYYY-MM" });
  assert.equal(callCount, 0);
});

test("OPTIONS returns public CORS preflight headers with no-store policy", (): void => {
  const response = OPTIONS();

  assert.equal(response.status, 204);
  assertPublicShareHeaders(response);
  assert.equal(response.headers.get("access-control-allow-methods"), "GET, OPTIONS");
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
});
