import assert from "node:assert/strict";
import test from "node:test";

import {
  postEnableMonthlyCategoryShareRouteWithDeps,
  putMonthlyCategoryShareItemsRouteWithDeps,
  type MonthlyCategoryShareRouteDependencies,
} from "@/server/api/monthlyCategoryShareSettings";
import type { MonthlyCategoryShareSettingsResponse } from "@/server/community/monthlyCategoryShareTypes";

const createResponsePayload = (): MonthlyCategoryShareSettingsResponse => ({
  settings: {
    enabled: false,
    indexingEnabled: false,
    displayLabel: "",
    monthFrom: "2026-01",
    monthTo: null,
  },
  dashboardUrl: "http://localhost/share/monthly/token",
  jsonUrl: "http://localhost/api/share/monthly/token?monthFrom=2026-01&monthTo=2027-12",
  selectedItems: [],
  availableSpendCategories: ["Food"],
});

const createDependencies = (
  overrides: Partial<MonthlyCategoryShareRouteDependencies>,
): MonthlyCategoryShareRouteDependencies => ({
  getMonthlyCategoryShareSettings: overrides.getMonthlyCategoryShareSettings ?? (async () => {
    throw new Error("Unexpected getMonthlyCategoryShareSettings call");
  }),
  updateMonthlyCategoryShareSettings: overrides.updateMonthlyCategoryShareSettings ?? (async () => {
    throw new Error("Unexpected updateMonthlyCategoryShareSettings call");
  }),
  replaceMonthlyCategoryShareItems: overrides.replaceMonthlyCategoryShareItems ?? (async () => {
    throw new Error("Unexpected replaceMonthlyCategoryShareItems call");
  }),
  enableMonthlyCategoryShare: overrides.enableMonthlyCategoryShare ?? (async () => {
    throw new Error("Unexpected enableMonthlyCategoryShare call");
  }),
  disableMonthlyCategoryShare: overrides.disableMonthlyCategoryShare ?? (async () => {
    throw new Error("Unexpected disableMonthlyCategoryShare call");
  }),
  updateMonthlyCategoryShareIndexing: overrides.updateMonthlyCategoryShareIndexing ?? (async () => {
    throw new Error("Unexpected updateMonthlyCategoryShareIndexing call");
  }),
  rotateMonthlyCategoryShareToken: overrides.rotateMonthlyCategoryShareToken ?? (async () => {
    throw new Error("Unexpected rotateMonthlyCategoryShareToken call");
  }),
  getUserSettings: overrides.getUserSettings ?? (async () => {
    throw new Error("Unexpected getUserSettings call");
  }),
});

const createJsonRequest = (
  path: string,
  method: string,
  body: unknown,
  cookie: string | null,
): Request => {
  const headers = new Headers({ "content-type": "application/json" });
  headers.set("x-user-id", "user-1");
  headers.set("x-workspace-id", "workspace-1");
  if (cookie !== null) {
    headers.set("cookie", cookie);
  }
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    body: JSON.stringify(body),
  });
};

test("postEnableMonthlyCategoryShareRouteWithDeps rejects a phrase from the wrong locale", async (): Promise<void> => {
  let enableCalled = false;
  const response = await postEnableMonthlyCategoryShareRouteWithDeps(
    createJsonRequest(
      "/api/community/monthly-category-share/enable",
      "POST",
      { confirmationPhrase: "make public" },
      "locale=ru",
    ),
    createDependencies({
      getUserSettings: async () => ({
        locale: "ru",
        numberFormat: "1,234.56",
        dateFormat: "YYYY-MM-DD",
      }),
      enableMonthlyCategoryShare: async () => {
        enableCalled = true;
        return createResponsePayload();
      },
    }),
  );

  assert.equal(response.status, 400);
  assert.equal(await response.text(), "Confirmation phrase does not match");
  assert.equal(enableCalled, false);
});

test("postEnableMonthlyCategoryShareRouteWithDeps accepts the localized public-link phrase", async (): Promise<void> => {
  const originalCorsOrigin = process.env.CORS_ORIGIN;
  delete process.env.CORS_ORIGIN;
  let receivedContext: ReadonlyArray<string> | null = null;
  try {
    const response = await postEnableMonthlyCategoryShareRouteWithDeps(
      createJsonRequest(
        "/api/community/monthly-category-share/enable",
        "POST",
        { confirmationPhrase: "make public" },
        "locale=en",
      ),
      createDependencies({
        getUserSettings: async () => ({
          locale: "en",
          numberFormat: "1,234.56",
          dateFormat: "YYYY-MM-DD",
        }),
        enableMonthlyCategoryShare: async (userId, workspaceId, appOrigin) => {
          receivedContext = [userId, workspaceId, appOrigin];
          return createResponsePayload();
        },
      }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(receivedContext, ["user-1", "workspace-1", "http://localhost"]);
    assert.deepEqual(await response.json(), createResponsePayload());
  } finally {
    if (originalCorsOrigin === undefined) {
      delete process.env.CORS_ORIGIN;
    } else {
      process.env.CORS_ORIGIN = originalCorsOrigin;
    }
  }
});

test("putMonthlyCategoryShareItemsRouteWithDeps rejects income selections in V1", async (): Promise<void> => {
  let replaceCalled = false;
  const response = await putMonthlyCategoryShareItemsRouteWithDeps(
    createJsonRequest(
      "/api/community/monthly-category-share/items",
      "PUT",
      {
        items: [
          { direction: "income", category: "Salary", accessLevel: "monthly_values" },
        ],
      },
      "locale=en",
    ),
    createDependencies({
      replaceMonthlyCategoryShareItems: async () => {
        replaceCalled = true;
        return createResponsePayload();
      },
    }),
  );

  assert.equal(response.status, 400);
  assert.equal(await response.text(), "items[].direction must be 'spend'");
  assert.equal(replaceCalled, false);
});

test("putMonthlyCategoryShareItemsRouteWithDeps requires explicit item access levels", async (): Promise<void> => {
  let replaceCalled = false;
  const response = await putMonthlyCategoryShareItemsRouteWithDeps(
    createJsonRequest(
      "/api/community/monthly-category-share/items",
      "PUT",
      {
        items: [
          { direction: "spend", category: "Food" },
        ],
      },
      "locale=en",
    ),
    createDependencies({
      replaceMonthlyCategoryShareItems: async () => {
        replaceCalled = true;
        return createResponsePayload();
      },
    }),
  );

  assert.equal(response.status, 400);
  assert.equal(await response.text(), "items[].accessLevel must be 'category_only' or 'monthly_values'");
  assert.equal(replaceCalled, false);
});
