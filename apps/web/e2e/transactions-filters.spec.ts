import { expect, test, type Locator, type Page, type Response } from "@playwright/test";

import {
  attachFailureDiagnostics,
  createTestWorkspace,
  createTransaction,
  deleteTestWorkspace,
  ensureAllVisibilityMode,
  runIdFromClock,
  setWorkspaceCookie,
  setupBrowserSession,
  signInWithDemoEmail,
} from "./live-smoke.actions";

type TransactionsResponseBody = Readonly<{
  entries: ReadonlyArray<Readonly<{
    accountId: string;
    currency: string;
    kind: string;
    category: string | null;
    counterparty: string | null;
    note: string | null;
  }>>;
  total: number;
}>;

type CountLabel = Readonly<{
  shown: number;
  total: number;
}>;

const externalUiTimeoutMs = 30_000;

test("transactions filters work in deployed app with authenticated workspace data", async ({ page, baseURL }, testInfo) => {
  if (baseURL === undefined) {
    throw new Error("Playwright baseURL is required");
  }

  const runId = runIdFromClock();
  const workspaceName = `E2E filters ${runId}`;
  const accountUsd = `E2E Filter USD ${runId}`;
  const accountEur = `E2E Filter EUR ${runId}`;
  const accountGbp = `E2E Filter GBP ${runId}`;
  const groceries = `E2E Filter Groceries ${runId}`;
  const transport = `E2E Filter Transport ${runId}`;
  const dining = `E2E Filter Dining ${runId}`;
  const employer = `E2E Employer ${runId}`;
  const storeOne = `E2E Store 1 ${runId}`;
  const storeTwo = `E2E Store 2 ${runId}`;
  const timestamp = new Date().toISOString();
  let workspaceId: string | null = null;

  try {
    const tokens = await signInWithDemoEmail();
    await setupBrowserSession(page, tokens);
    await setLocaleCookie(page, baseURL, "en");

    const workspace = await createTestWorkspace(page, workspaceName);
    workspaceId = workspace.workspaceId;
    await setWorkspaceCookie(page, workspace.workspaceId);
    await page.goto(baseURL, { waitUntil: "domcontentloaded" });
    await expect(page).not.toHaveURL(/\/login/);
    await ensureAllVisibilityMode(page);

    await createTransaction(page, {
      ts: timestamp,
      accountId: accountUsd,
      amount: -11.11,
      currency: "USD",
      kind: "spend",
      category: groceries,
      counterparty: storeOne,
      note: `usd-groceries-${runId}`,
    });
    await createTransaction(page, {
      ts: timestamp,
      accountId: accountEur,
      amount: -22.22,
      currency: "EUR",
      kind: "spend",
      category: transport,
      counterparty: storeTwo,
      note: `eur-transport-${runId}`,
    });
    await createTransaction(page, {
      ts: timestamp,
      accountId: accountUsd,
      amount: 33.33,
      currency: "USD",
      kind: "income",
      category: dining,
      counterparty: employer,
      note: `usd-income-${runId}`,
    });
    await createTransaction(page, {
      ts: timestamp,
      accountId: accountGbp,
      amount: -44.44,
      currency: "GBP",
      kind: "transfer",
      category: null,
      counterparty: null,
      note: `gbp-transfer-${runId}`,
    });

    await page.goto(`${baseURL}/transactions`, { waitUntil: "domcontentloaded" });
    await ensureAllVisibilityMode(page);
    await expect(page.getByRole("heading", { name: "Transactions", exact: true })).toBeVisible({ timeout: externalUiTimeoutMs });
    await expect(page.locator("main").getByRole("table").first()).toContainText(accountUsd, { timeout: externalUiTimeoutMs });
    await expect(page.locator("main").getByRole("table").first()).toContainText(`usd-groceries-${runId}`, { timeout: externalUiTimeoutMs });
    await expect(page.locator("main").getByRole("table").first()).toContainText(`eur-transport-${runId}`, { timeout: externalUiTimeoutMs });
    await expect(page.locator("main").getByRole("table").first()).toContainText(`usd-income-${runId}`, { timeout: externalUiTimeoutMs });
    await expect(page.locator("main").getByRole("table").first()).toContainText(`gbp-transfer-${runId}`, { timeout: externalUiTimeoutMs });

    const initialCount = await readCountLabel(page);
    expect(initialCount.total).toBeGreaterThanOrEqual(4);
    expect(initialCount.shown).toBeGreaterThanOrEqual(4);

    const filtersTrigger = page.getByTestId("transactions-filters-trigger");
    await expect(page.getByTestId("transactions-filters-badge")).toHaveCount(0);
    await filtersTrigger.click();

    const filtersOverlay = page.getByTestId("transactions-filters-overlay");
    await expect(filtersOverlay).toBeVisible();
    await expect(filtersOverlay.locator('[data-testid$="-search"]')).toHaveCount(0);
    await expectPopoverAnchoredToTrigger(filtersTrigger, filtersOverlay);
    await page.keyboard.press("Escape");
    await expect(filtersOverlay).toHaveCount(0);

    await filtersTrigger.click();
    await expect(filtersOverlay).toBeVisible();
    await expect(filtersOverlay.locator('[data-testid$="-search"]')).toHaveCount(0);

    const accountSearch = await openFilterPicker(page, "transactions-filters-account");
    await expect(accountSearch).toHaveValue("");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("transactions-filters-account-picker")).toHaveCount(0);
    await expect(filtersOverlay).toBeVisible();

    await openFilterPicker(page, "transactions-filters-account");
    await expect(page.getByTestId("transactions-filters-account-picker")).toBeVisible();
    await filtersOverlay.getByText("Filters", { exact: true }).click();
    await expect(page.getByTestId("transactions-filters-account-picker")).toHaveCount(0);
    await expect(filtersOverlay).toBeVisible();

    await openFilterPicker(page, "transactions-filters-account");
    await expect(page.getByTestId("transactions-filters-account-picker")).toBeVisible();
    await openFilterPicker(page, "transactions-filters-category");
    await expect(page.getByTestId("transactions-filters-account-picker")).toHaveCount(0);
    await expect(page.getByTestId("transactions-filters-category-picker")).toBeVisible();
    await openFilterPicker(page, "transactions-filters-account");

    await accountSearch.fill(`USD ${runId}`);
    const accountUsdResponse = await waitForTransactionsResponse(page, async () => {
      await page.getByTestId("transactions-filters-account-options").getByLabel(accountUsd, { exact: true }).click();
    });
    expectSortedQueryValues(accountUsdResponse.url(), "accountIds", [accountUsd]);
    await expect(page.getByTestId("transactions-filters-badge")).toHaveText("1");

    await accountSearch.fill(`EUR ${runId}`);
    const accountEurResponse = await waitForTransactionsResponse(page, async () => {
      await page.getByTestId("transactions-filters-account-options").getByLabel(accountEur, { exact: true }).click();
    });
    expectSortedQueryValues(accountEurResponse.url(), "accountIds", [accountUsd, accountEur]);
    const accountBody = await accountEurResponse.json() as TransactionsResponseBody;
    expect(accountBody.total).toBe(3);
    expect(accountBody.entries.every((entry) =>
      entry.accountId === accountUsd || entry.accountId === accountEur,
    )).toBe(true);

    await accountSearch.fill("zzzz");
    await expect(page.getByTestId("transactions-filters-account-options").getByText(accountUsd, { exact: true })).toBeVisible();
    await expect(page.getByTestId("transactions-filters-account-options").getByText(accountEur, { exact: true })).toBeVisible();
    await expect(page.getByTestId("transactions-filters-account-options").getByText(accountGbp, { exact: true })).toHaveCount(0);

    await openFilterPicker(page, "transactions-filters-kind");
    const kindResponse = await waitForTransactionsResponse(page, async () => {
      await page.getByTestId("transactions-filters-kind-options").getByLabel("Spend", { exact: true }).click();
    });
    expectSortedQueryValues(kindResponse.url(), "accountIds", [accountUsd, accountEur]);
    expectSortedQueryValues(kindResponse.url(), "kinds", ["spend"]);
    const kindBody = await kindResponse.json() as TransactionsResponseBody;
    expect(kindBody.total).toBe(2);
    expect(kindBody.entries.every((entry) => entry.kind === "spend")).toBe(true);
    await expect(page.getByTestId("transactions-filters-badge")).toHaveText("2");

    await openFilterPicker(page, "transactions-filters-currency");
    const currencyResponse = await waitForTransactionsResponse(page, async () => {
      await page.getByTestId("transactions-filters-currency-options").getByLabel("USD", { exact: true }).click();
    });
    expectSortedQueryValues(currencyResponse.url(), "currencies", ["USD"]);
    const currencyBody = await currencyResponse.json() as TransactionsResponseBody;
    expect(currencyBody.total).toBe(1);
    expect(currencyBody.entries.every((entry) => entry.currency === "USD" && entry.kind === "spend")).toBe(true);
    await expect(page.getByTestId("transactions-filters-badge")).toHaveText("3");

    await openFilterPicker(page, "transactions-filters-category");
    const categoryResponse = await waitForTransactionsResponse(page, async () => {
      await page.getByTestId("transactions-filters-category-options").getByLabel(groceries, { exact: true }).click();
    });
    expectSortedQueryValues(categoryResponse.url(), "categories", [groceries]);
    const categoryBody = await categoryResponse.json() as TransactionsResponseBody;
    expect(categoryBody.total).toBe(1);
    expect(categoryBody.entries[0]?.note).toBe(`usd-groceries-${runId}`);
    await expect(page.getByTestId("transactions-filters-badge")).toHaveText("4");

    await page.getByRole("heading", { name: "Transactions", exact: true }).click();
    await expect(filtersOverlay).toHaveCount(0);

    await filtersTrigger.click();
    await expect(filtersOverlay.locator('[data-testid$="-search"]')).toHaveCount(0);
    await openFilterPicker(page, "transactions-filters-account");
    await expect(page.getByTestId("transactions-filters-account-options").getByLabel(accountUsd, { exact: true })).toBeChecked();
    await openFilterPicker(page, "transactions-filters-category");
    await expect(page.getByTestId("transactions-filters-category-options").getByLabel(groceries, { exact: true })).toBeChecked();

    const clearFiltersResponse = await waitForTransactionsResponse(page, async () => {
      await page.getByRole("button", { name: "Reset all", exact: true }).click();
    });
    expectSortedQueryValues(clearFiltersResponse.url(), "accountIds", []);
    expectSortedQueryValues(clearFiltersResponse.url(), "categories", []);
    expectSortedQueryValues(clearFiltersResponse.url(), "kinds", []);
    expectSortedQueryValues(clearFiltersResponse.url(), "currencies", []);
    expectSortedQueryValues(clearFiltersResponse.url(), "counterparties", []);
    await expect(page.getByTestId("transactions-filters-badge")).toHaveCount(0);

    const resetBody = await clearFiltersResponse.json() as TransactionsResponseBody;
    const resetCount = await readCountLabel(page);
    expect(resetBody.total).toBe(initialCount.total);
    expect(resetCount.total).toBe(initialCount.total);
    expect(resetCount.shown).toBe(initialCount.shown);

    await openFilterPicker(page, "transactions-filters-category");
    const uncategorizedResponse = await waitForTransactionsResponse(page, async () => {
      await page.getByTestId("transactions-filters-category-options").getByLabel("Uncategorized", { exact: true }).click();
    });
    expectSortedQueryValues(uncategorizedResponse.url(), "categories", [""]);
    const uncategorizedBody = await uncategorizedResponse.json() as TransactionsResponseBody;
    expect(uncategorizedBody.total).toBe(1);
    expect(uncategorizedBody.entries.every((entry) => entry.category === null)).toBe(true);

    await openFilterPicker(page, "transactions-filters-counterparty");
    const noCounterpartyResponse = await waitForTransactionsResponse(page, async () => {
      await page.getByTestId("transactions-filters-counterparty-options").getByLabel("No counterparty", { exact: true }).click();
    });
    expectSortedQueryValues(noCounterpartyResponse.url(), "counterparties", [""]);
    const noCounterpartyBody = await noCounterpartyResponse.json() as TransactionsResponseBody;
    expect(noCounterpartyBody.total).toBe(1);
    expect(noCounterpartyBody.entries.every((entry) => entry.counterparty === null)).toBe(true);

    await openFilterPicker(page, "transactions-filters-kind");
    const transferResponse = await waitForTransactionsResponse(page, async () => {
      await page.getByTestId("transactions-filters-kind-options").getByLabel("Transfer", { exact: true }).click();
    });
    expectSortedQueryValues(transferResponse.url(), "kinds", ["transfer"]);
    const transferBody = await transferResponse.json() as TransactionsResponseBody;
    expect(transferBody.total).toBe(1);
    expect(transferBody.entries.every((entry) => entry.kind === "transfer")).toBe(true);
  } catch (error) {
    await attachFailureDiagnostics(page, testInfo, "transactions-filters");
    throw error;
  } finally {
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

async function openFilterPicker(page: Page, testId: string): Promise<Locator> {
  const row = page.getByTestId(`${testId}-row`);
  await row.click();
  const picker = page.getByTestId(`${testId}-picker`);
  await expect(picker).toBeVisible({ timeout: externalUiTimeoutMs });
  return page.getByTestId(`${testId}-search`);
}

async function setLocaleCookie(page: Page, baseURL: string, locale: string): Promise<void> {
  const url = new URL(baseURL);
  await page.context().addCookies([
    {
      name: "locale",
      value: locale,
      domain: url.hostname,
      path: "/",
      httpOnly: false,
      secure: url.protocol === "https:",
      sameSite: "Lax",
    },
  ]);
}

async function readCountLabel(page: Page): Promise<CountLabel> {
  const label = page.getByText(/\d+ of \d+ entries/, { exact: false }).first();
  await expect(label).toBeVisible({ timeout: externalUiTimeoutMs });
  const text = await label.textContent();
  if (text === null) {
    throw new Error("Transactions count label is empty");
  }

  const match = text.match(/(\d+)\s+of\s+(\d+)\s+entries/);
  if (match === null) {
    throw new Error(`Unexpected count label: ${text}`);
  }

  return {
    shown: Number(match[1]),
    total: Number(match[2]),
  };
}

async function waitForTransactionsResponse(
  page: Page,
  action: () => Promise<void>,
): Promise<Response> {
  const [response] = await Promise.all([
    page.waitForResponse((candidate) =>
      candidate.request().method() === "GET"
      && candidate.status() === 200
      && candidate.url().includes("/api/transactions?"),
      { timeout: externalUiTimeoutMs },
    ),
    action(),
  ]);

  return response;
}

function getRepeatedQueryValues(url: string, key: string): ReadonlyArray<string> {
  return new URL(url).searchParams.getAll(key);
}

function expectSortedQueryValues(url: string, key: string, expected: ReadonlyArray<string>): void {
  expect([...getRepeatedQueryValues(url, key)].sort()).toEqual([...expected].sort());
}

async function expectPopoverAnchoredToTrigger(trigger: Locator, popover: Locator): Promise<void> {
  const triggerBox = await trigger.boundingBox();
  const popoverBox = await popover.boundingBox();

  if (triggerBox === null || popoverBox === null) {
    throw new Error("Missing filter bounding boxes");
  }

  expect(Math.abs(popoverBox.x - triggerBox.x)).toBeLessThan(24);
  expect(popoverBox.y).toBeGreaterThan(triggerBox.y);
}
