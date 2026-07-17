import assert from "node:assert/strict";
import test from "node:test";

import { getAccountSuggestionsRouteWithDeps } from "@/app/api/account-suggestions/route";

const expectedSuggestions = [
  { accountId: "checking-eur", currency: "EUR" },
  { accountId: "checking-usd", currency: "USD" },
] as const;

test("account suggestions route returns the workspace-scoped response without caching", async (): Promise<void> => {
  let receivedContext: ReadonlyArray<string> | null = null;
  const request = new Request("http://localhost/api/account-suggestions", {
    headers: {
      "x-user-id": "user-1",
      "x-workspace-id": "workspace-1",
    },
  });

  const response = await getAccountSuggestionsRouteWithDeps(request, {
    getAccountSuggestions: async (userId, workspaceId) => {
      receivedContext = [userId, workspaceId];
      return expectedSuggestions;
    },
    getDemoAccountSuggestions: () => {
      throw new Error("Unexpected demo account suggestions call");
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(receivedContext, ["user-1", "workspace-1"]);
  assert.deepEqual(await response.json(), expectedSuggestions);
  assert.equal(response.headers.get("cache-control"), "no-store, no-cache, must-revalidate");
  assert.equal(response.headers.get("pragma"), "no-cache");
  assert.equal(response.headers.get("expires"), "0");
});

test("account suggestions route serves demo data without trusted identity headers", async (): Promise<void> => {
  const request = new Request("http://localhost/api/account-suggestions", {
    headers: { cookie: "demo=true" },
  });

  const response = await getAccountSuggestionsRouteWithDeps(request, {
    getAccountSuggestions: async () => {
      throw new Error("Unexpected live account suggestions call");
    },
    getDemoAccountSuggestions: () => expectedSuggestions,
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), expectedSuggestions);
});
