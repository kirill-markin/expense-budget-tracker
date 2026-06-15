import { expect, test, type Browser, type Page } from "@playwright/test";

import {
  attachFailureDiagnostics,
  createTestWorkspace,
  createTransaction,
  deleteTestWorkspace,
  runIdFromClock,
  setWorkspaceCookie,
  setupBrowserSession,
  signInWithDemoEmail,
} from "./live-smoke.actions";

type PublicShareSettingsResponse = Readonly<{
  settings: Readonly<{
    enabled: boolean;
    indexingEnabled: boolean;
    displayLabel: string;
    monthFrom: string | null;
    monthTo: string | null;
  }>;
  dashboardUrl: string | null;
  jsonUrl: string | null;
  selectedItems: ReadonlyArray<Readonly<{
    direction: "spend";
    category: string;
    accessLevel: "category_only" | "monthly_values";
  }>>;
}>;

type PublicShareBody = Readonly<{
  categories: ReadonlyArray<Readonly<{
    category: string;
    accessLevel: "category_only" | "monthly_values";
  }>>;
  cells: ReadonlyArray<Readonly<{
    month: string;
    category: string;
    amount: number;
  }>>;
  yearTotals: ReadonlyArray<Readonly<{
    year: string;
    category: string;
    amount: number;
  }>>;
}>;

const externalUiTimeoutMs = 30_000;
const forbiddenPublicJsonFields: ReadonlyArray<string> = [
  "workspaceId",
  "userId",
  "email",
  "entry_id",
  "event_id",
  "account_id",
  "counterparty",
  "note",
  "hasUnconvertible",
];

const offsetMonth = (base: string, offset: number): string => {
  const [year, month] = base.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
};

const currentMonth = (): string => {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
};

const monthTimestamp = (month: string): string =>
  `${month}-15T12:00:00.000Z`;

const browserFetch = async <T>(
  page: Page,
  baseUrl: string,
  path: string,
  method: "GET" | "POST" | "PUT",
  body: unknown | null,
): Promise<T> => {
  const result = await page.evaluate(
    async ({ url, requestMethod, requestBody }) => {
      const csrfMatch = document.cookie.match(/(?:^|;\s*)__Host-csrf=([0-9a-f]+)/);
      const csrfToken = csrfMatch !== null ? csrfMatch[1] : "";
      const headers: Record<string, string> = {};
      if (requestMethod !== "GET") {
        headers["Content-Type"] = "application/json";
        if (csrfToken !== "") {
          headers["x-csrf-token"] = csrfToken;
        }
      }

      const response = await fetch(url, {
        method: requestMethod,
        headers,
        body: requestBody === null ? undefined : JSON.stringify(requestBody),
        credentials: "same-origin",
      });
      const text = await response.text();
      return { ok: response.ok, status: response.status, text };
    },
    {
      url: `${baseUrl}${path}`,
      requestMethod: method,
      requestBody: body,
    },
  );

  if (!result.ok) {
    throw new Error(`${method} ${path} failed: status=${result.status} body=${result.text}`);
  }

  return JSON.parse(result.text) as T;
};

const setUserLocaleToEnglish = async (
  page: Page,
  baseUrl: string,
): Promise<void> => {
  await browserFetch<unknown>(
    page,
    baseUrl,
    "/api/user-settings",
    "PUT",
    { locale: "en" },
  );
};

const createPublicShare = async (
  page: Page,
  baseUrl: string,
  params: Readonly<{
    label: string;
    monthFrom: string;
    monthlyCategory: string;
    categoryOnlyCategory: string;
  }>,
): Promise<PublicShareSettingsResponse> => {
  await browserFetch<PublicShareSettingsResponse>(
    page,
    baseUrl,
    "/api/community/monthly-category-share",
    "PUT",
    {
      displayLabel: params.label,
      monthFrom: params.monthFrom,
      monthTo: null,
    },
  );
  await browserFetch<PublicShareSettingsResponse>(
    page,
    baseUrl,
    "/api/community/monthly-category-share/items",
    "PUT",
    {
      items: [
        { direction: "spend", category: params.monthlyCategory, accessLevel: "monthly_values" },
        { direction: "spend", category: params.categoryOnlyCategory, accessLevel: "category_only" },
      ],
    },
  );
  return browserFetch<PublicShareSettingsResponse>(
    page,
    baseUrl,
    "/api/community/monthly-category-share/enable",
    "POST",
    { confirmationPhrase: "make public" },
  );
};

const disablePublicShare = async (
  page: Page,
  baseUrl: string,
): Promise<PublicShareSettingsResponse> =>
  browserFetch<PublicShareSettingsResponse>(
    page,
    baseUrl,
    "/api/community/monthly-category-share/disable",
    "POST",
    {},
  );

const enablePublicShare = async (
  page: Page,
  baseUrl: string,
): Promise<PublicShareSettingsResponse> =>
  browserFetch<PublicShareSettingsResponse>(
    page,
    baseUrl,
    "/api/community/monthly-category-share/enable",
    "POST",
    { confirmationPhrase: "make public" },
  );

const rotatePublicShareToken = async (
  page: Page,
  baseUrl: string,
): Promise<PublicShareSettingsResponse> =>
  browserFetch<PublicShareSettingsResponse>(
    page,
    baseUrl,
    "/api/community/monthly-category-share/rotate-token",
    "POST",
    {},
  );

const updatePublicShareIndexing = async (
  page: Page,
  baseUrl: string,
  indexingEnabled: boolean,
): Promise<PublicShareSettingsResponse> => {
  const body = indexingEnabled
    ? { indexingEnabled, confirmationPhrase: "allow search" }
    : { indexingEnabled };
  return browserFetch<PublicShareSettingsResponse>(
    page,
    baseUrl,
    "/api/community/monthly-category-share/indexing",
    "PUT",
    body,
  );
};

const assertPublicShareJsonContract = (body: PublicShareBody): void => {
  const serialized = JSON.stringify(body);
  for (const field of forbiddenPublicJsonFields) {
    expect(serialized).not.toContain(field);
  }
};

const createUnauthenticatedPage = async (
  browser: Browser,
  baseURL: string,
): Promise<Page> => {
  const context = await browser.newContext({
    baseURL,
    ignoreHTTPSErrors: true,
  });
  return context.newPage();
};

test("public monthly share exposes only public aggregate data without private shell", async ({ browser, page, baseURL }, testInfo) => {
  if (baseURL === undefined) {
    throw new Error("Playwright baseURL is required");
  }

  const runId = runIdFromClock();
  const workspaceName = `E2E public share ${runId}`;
  const monthlyCategory = `E2E public groceries ${runId}`;
  const categoryOnlyCategory = `E2E public private travel ${runId}`;
  const privateMarker = `private-share-marker-${runId}`;
  const unconvertibleAmount = "1357.91";
  const incomeAmount = "2468.13";
  const categoryOnlyAmount = "9876.54";
  const currentMonthAmount = "4321.09";
  const nowMonth = currentMonth();
  const shareMonthFrom = offsetMonth(nowMonth, -15);
  const earlierVisibleMonth = shareMonthFrom;
  const latestSeedMonth = offsetMonth(nowMonth, -3);
  let workspaceId: string | null = null;
  let publicPage: Page | null = null;

  try {
    const tokens = await signInWithDemoEmail();
    await setupBrowserSession(page, tokens);

    const workspace = await createTestWorkspace(page, workspaceName);
    workspaceId = workspace.workspaceId;
    await setWorkspaceCookie(page, workspace.workspaceId);
    await page.goto(baseURL, { waitUntil: "domcontentloaded" });
    await setUserLocaleToEnglish(page, baseURL);

    await createTransaction(page, {
      ts: monthTimestamp(earlierVisibleMonth),
      accountId: `E2E public account ${runId}`,
      amount: -11.11,
      currency: "USD",
      kind: "spend",
      category: monthlyCategory,
      counterparty: `E2E public store ${runId}`,
      note: `monthly public value ${runId}`,
    });
    await createTransaction(page, {
      ts: monthTimestamp(latestSeedMonth),
      accountId: `E2E public account ${runId}`,
      amount: -22.22,
      currency: "USD",
      kind: "spend",
      category: monthlyCategory,
      counterparty: `E2E public store ${runId}`,
      note: `latest public value ${runId}`,
    });
    await createTransaction(page, {
      ts: monthTimestamp(latestSeedMonth),
      accountId: `E2E public account ${runId}`,
      amount: -Number(categoryOnlyAmount),
      currency: "USD",
      kind: "spend",
      category: categoryOnlyCategory,
      counterparty: privateMarker,
      note: privateMarker,
    });
    await createTransaction(page, {
      ts: monthTimestamp(latestSeedMonth),
      accountId: `E2E public account ${runId}`,
      amount: Number(incomeAmount),
      currency: "USD",
      kind: "income",
      category: monthlyCategory,
      counterparty: privateMarker,
      note: privateMarker,
    });
    await createTransaction(page, {
      ts: monthTimestamp(latestSeedMonth),
      accountId: `E2E public account ${runId}`,
      amount: -Number(unconvertibleAmount),
      currency: "ZZZ",
      kind: "spend",
      category: monthlyCategory,
      counterparty: privateMarker,
      note: privateMarker,
    });
    await createTransaction(page, {
      ts: monthTimestamp(nowMonth),
      accountId: `E2E public account ${runId}`,
      amount: -Number(currentMonthAmount),
      currency: "USD",
      kind: "spend",
      category: monthlyCategory,
      counterparty: privateMarker,
      note: privateMarker,
    });

    let settings = await createPublicShare(page, baseURL, {
      label: `E2E public share ${runId}`,
      monthFrom: shareMonthFrom,
      monthlyCategory,
      categoryOnlyCategory,
    });
    if (settings.dashboardUrl === null || settings.jsonUrl === null) {
      throw new Error(`Public monthly share did not return public URLs: ${JSON.stringify(settings)}`);
    }

    publicPage = await createUnauthenticatedPage(browser, baseURL);
    const disabledSettings = await disablePublicShare(page, baseURL);
    expect(disabledSettings.settings.enabled).toBe(false);
    expect(disabledSettings.settings.indexingEnabled).toBe(false);
    expect(disabledSettings.dashboardUrl).toBe(settings.dashboardUrl);
    expect(disabledSettings.jsonUrl).toBe(settings.jsonUrl);
    expect((await publicPage.request.get(settings.jsonUrl)).status()).toBe(404);

    const reenabledSettings = await enablePublicShare(page, baseURL);
    expect(reenabledSettings.settings.enabled).toBe(true);
    expect(reenabledSettings.dashboardUrl).toBe(settings.dashboardUrl);
    expect(reenabledSettings.jsonUrl).toBe(settings.jsonUrl);
    expect((await publicPage.request.get(settings.jsonUrl)).status()).toBe(200);

    const indexedSettings = await updatePublicShareIndexing(page, baseURL, true);
    expect(indexedSettings.settings.indexingEnabled).toBe(true);
    expect(indexedSettings.dashboardUrl).toBe(settings.dashboardUrl);
    expect(indexedSettings.jsonUrl).toBe(settings.jsonUrl);
    const noindexSettings = await updatePublicShareIndexing(page, baseURL, false);
    expect(noindexSettings.settings.indexingEnabled).toBe(false);
    expect(noindexSettings.dashboardUrl).toBe(settings.dashboardUrl);
    expect(noindexSettings.jsonUrl).toBe(settings.jsonUrl);

    const oldJsonUrl = settings.jsonUrl;
    const oldDashboardUrl = settings.dashboardUrl;
    settings = await rotatePublicShareToken(page, baseURL);
    if (settings.dashboardUrl === null || settings.jsonUrl === null) {
      throw new Error(`Public monthly share rotation did not return public URLs: ${JSON.stringify(settings)}`);
    }
    expect(settings.dashboardUrl).not.toBe(oldDashboardUrl);
    expect(settings.jsonUrl).not.toBe(oldJsonUrl);
    expect((await publicPage.request.get(oldJsonUrl)).status()).toBe(404);

    const forbiddenApiRequests: Array<string> = [];
    const publicApiResponseBodies: Array<string> = [];
    const baseOrigin = new URL(baseURL).origin;
    publicPage.on("request", (request) => {
      const url = new URL(request.url());
      if (
        url.origin === baseOrigin
        && url.pathname.startsWith("/api/")
        && !url.pathname.startsWith("/api/share/monthly/")
      ) {
        forbiddenApiRequests.push(request.url());
      }
    });

    const apiResponse = await publicPage.request.get(settings.jsonUrl);
    expect(apiResponse.status()).toBe(200);
    const apiText = await apiResponse.text();
    publicApiResponseBodies.push(apiText);
    const apiBody = JSON.parse(apiText) as PublicShareBody;
    assertPublicShareJsonContract(apiBody);
    expect(apiBody.categories).toEqual([
      { category: monthlyCategory, accessLevel: "monthly_values" },
      { category: categoryOnlyCategory, accessLevel: "category_only" },
    ]);
    expect(apiBody.cells.every((cell) => cell.category !== categoryOnlyCategory)).toBe(true);
    expect(apiBody.yearTotals.every((total) => total.category !== categoryOnlyCategory)).toBe(true);

    await publicPage.goto(settings.dashboardUrl, { waitUntil: "domcontentloaded" });
    await expect(publicPage.locator("main table")).toBeVisible({ timeout: externalUiTimeoutMs });

    const loadEarlierButton = publicPage.getByTestId("public-share-load-earlier");
    await expect(loadEarlierButton).toBeVisible({ timeout: externalUiTimeoutMs });
    await expect(loadEarlierButton).toBeEnabled({ timeout: externalUiTimeoutMs });
    const earlierResponse = await Promise.all([
      publicPage.waitForResponse((response) => new URL(response.url()).pathname.startsWith("/api/share/monthly/")),
      loadEarlierButton.click(),
    ]).then(([response]) => response);
    publicApiResponseBodies.push(await earlierResponse.text());

    await expect(publicPage.locator("header.topbar")).toHaveCount(0);
    await expect(publicPage.locator("nav.nav")).toHaveCount(0);
    await expect(publicPage.locator(".demo-banner")).toHaveCount(0);
    await expect(publicPage.locator('button[aria-haspopup="true"]')).toHaveCount(0);
    await expect(publicPage.locator("textarea")).toHaveCount(0);
    expect(forbiddenApiRequests).toEqual([]);

    const publicBodies = [
      ...publicApiResponseBodies,
      await publicPage.content(),
    ].join("\n");
    expect(publicBodies).not.toContain(privateMarker);
    expect(publicBodies).not.toContain(categoryOnlyAmount);
    expect(publicBodies).not.toContain(incomeAmount);
    expect(publicBodies).not.toContain(unconvertibleAmount);
    expect(publicBodies).not.toContain(currentMonthAmount);
    expect(publicBodies).not.toContain("hasUnconvertible");
    await publicPage.context().close();
    publicPage = null;
  } catch (error) {
    await attachFailureDiagnostics(page, testInfo, "public-monthly-share");
    throw error;
  } finally {
    if (publicPage !== null) {
      await publicPage.context().close();
    }
    if (workspaceId !== null) {
      try {
        await deleteTestWorkspace(page, workspaceId, workspaceName);
      } catch (cleanupError) {
        const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        console.error(`[cleanup] Failed to delete workspace ${workspaceId}: ${message}`);
      }
    }
  }
});
