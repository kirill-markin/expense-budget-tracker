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

const createContext = (token: string): { params: Promise<{ token: string }> } => ({
  params: Promise.resolve({ token }),
});

const createGetRequest = (query: string): Request =>
  new Request(`http://localhost/api/share/monthly/token-1${query}`, { method: "GET" });

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
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  assert.deepEqual(calls, [{ token: "token-1", monthFrom: "2024-01", monthTo: "2025-12" }]);
  assert.deepEqual(await response.json(), SHARE);
});

test("getPublicMonthlyShareRouteWithDeps returns equivalent 404 responses for missing shares", async (): Promise<void> => {
  const dependencies = {
    getPublicMonthlyCategoryShare: async (): Promise<PublicMonthlyCategoryShare | null> => null,
  };

  const first = await getPublicMonthlyShareRouteWithDeps(
    createGetRequest("?monthFrom=2025-03&monthTo=2025-04"),
    createContext("unknown-token"),
    dependencies,
  );
  const second = await getPublicMonthlyShareRouteWithDeps(
    createGetRequest("?monthFrom=2025-03&monthTo=2025-04"),
    createContext("revoked-token"),
    dependencies,
  );

  assert.equal(first.status, 404);
  assert.equal(second.status, 404);
  assert.equal(first.headers.get("access-control-allow-origin"), "*");
  assert.equal(await first.text(), await second.text());
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
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.deepEqual(await response.json(), { error: "Invalid month format. Expected YYYY-MM" });
  assert.equal(callCount, 0);
});

test("OPTIONS returns public CORS preflight headers with no-store policy", (): void => {
  const response = OPTIONS();

  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(response.headers.get("access-control-allow-methods"), "GET, OPTIONS");
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
});
