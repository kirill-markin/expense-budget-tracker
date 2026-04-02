import { expect, test, type Locator, type Page, type Response } from "@playwright/test";

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

type TransactionsResponseBody = Readonly<{
  entries: ReadonlyArray<Readonly<{
    accountId: string;
    category: string | null;
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
  const timestamp = new Date().toISOString();
  let workspaceId: string | null = null;

  try {
    const tokens = await signInWithDemoEmail();
    await setupBrowserSession(page, tokens);
    await setLocaleCookie(page, baseURL, "en");

    const workspace = await createTestWorkspace(page, workspaceName);
    workspaceId = workspace.workspaceId;
    await setWorkspaceCookie(page, workspace.workspaceId);

    await createTransaction(page, {
      ts: timestamp,
      accountId: accountUsd,
      amount: -11.11,
      currency: "USD",
      kind: "spend",
      category: groceries,
      counterparty: "E2E Store 1",
      note: `usd-groceries-${runId}`,
    });
    await createTransaction(page, {
      ts: timestamp,
      accountId: accountEur,
      amount: -22.22,
      currency: "EUR",
      kind: "spend",
      category: transport,
      counterparty: "E2E Store 2",
      note: `eur-transport-${runId}`,
    });
    await createTransaction(page, {
      ts: timestamp,
      accountId: accountUsd,
      amount: -33.33,
      currency: "USD",
      kind: "spend",
      category: transport,
      counterparty: "E2E Store 3",
      note: `usd-transport-${runId}`,
    });
    await createTransaction(page, {
      ts: timestamp,
      accountId: accountGbp,
      amount: -44.44,
      currency: "GBP",
      kind: "spend",
      category: dining,
      counterparty: "E2E Store 4",
      note: `gbp-dining-${runId}`,
    });

    await page.goto(`${baseURL}/transactions`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Transactions", exact: true })).toBeVisible({ timeout: externalUiTimeoutMs });
    await expect(page.locator("body")).toContainText(accountUsd);
    await expect(page.locator("body")).toContainText(`usd-groceries-${runId}`);
    await expect(page.locator("body")).toContainText(`eur-transport-${runId}`);
    await expect(page.locator("body")).toContainText(`usd-transport-${runId}`);
    await expect(page.locator("body")).toContainText(`gbp-dining-${runId}`);

    const initialCount = await readCountLabel(page);
    expect(initialCount.total).toBeGreaterThanOrEqual(4);
    expect(initialCount.shown).toBeGreaterThanOrEqual(4);

    const accountTrigger = page.getByTestId("transactions-account-filter");
    await accountTrigger.click();

    const accountPopover = page.getByTestId("transactions-account-filter-popover");
    const accountSearch = page.getByTestId("transactions-account-filter-search");
    await expect(accountPopover).toBeVisible();
    await expect(accountSearch).toHaveValue("");
    await expectPopoverAnchoredToTrigger(accountTrigger, accountPopover);

    await accountSearch.fill(`USD ${runId}`);
    const accountUsdResponse = await waitForTransactionsResponse(page, async () => {
      await accountPopover.getByLabel(accountUsd, { exact: true }).click();
    });
    await expect(accountTrigger).toContainText(accountUsd);
    expectSortedQueryValues(accountUsdResponse.url(), "accountIds", [accountUsd]);

    await accountSearch.fill(`EUR ${runId}`);
    const accountEurResponse = await waitForTransactionsResponse(page, async () => {
      await accountPopover.getByLabel(accountEur, { exact: true }).click();
    });
    await expect(accountTrigger).toContainText("2 selected");
    expectSortedQueryValues(accountEurResponse.url(), "accountIds", [accountUsd, accountEur]);

    await accountSearch.fill("zzzz");
    await expect(accountPopover.getByText(accountUsd, { exact: true })).toBeVisible();
    await expect(accountPopover.getByText(accountEur, { exact: true })).toBeVisible();
    await expect(accountPopover.getByText(accountGbp, { exact: true })).toHaveCount(0);

    await page.keyboard.press("Escape");
    await expect(accountPopover).toHaveCount(0);
    await accountTrigger.click();
    await expect(accountSearch).toHaveValue("");
    await page.keyboard.press("Escape");

    const accountFilteredCount = await readCountLabel(page);
    expect(accountFilteredCount.total).toBe(3);
    expect(accountFilteredCount.shown).toBe(3);

    const categoryTrigger = page.getByTestId("transactions-category-filter");
    await categoryTrigger.click();

    const categoryPopover = page.getByTestId("transactions-category-filter-popover");
    const categorySearch = page.getByTestId("transactions-category-filter-search");
    await expect(categoryPopover).toBeVisible();
    await expect(categorySearch).toHaveValue("");
    await expectPopoverAnchoredToTrigger(categoryTrigger, categoryPopover);

    await categorySearch.fill(`Groceries ${runId}`);
    const groceriesResponse = await waitForTransactionsResponse(page, async () => {
      await categoryPopover.getByLabel(groceries, { exact: true }).click();
    });
    expectSortedQueryValues(groceriesResponse.url(), "accountIds", [accountUsd, accountEur]);
    expectSortedQueryValues(groceriesResponse.url(), "categories", [groceries]);

    await categorySearch.fill(`Transport ${runId}`);
    const transportResponse = await waitForTransactionsResponse(page, async () => {
      await categoryPopover.getByLabel(transport, { exact: true }).click();
    });
    await expect(categoryTrigger).toContainText("2 selected");
    expectSortedQueryValues(transportResponse.url(), "categories", [groceries, transport]);

    const filteredBody = await transportResponse.json() as TransactionsResponseBody;
    expect(filteredBody.total).toBe(3);
    expect(filteredBody.entries.every((entry) =>
      (entry.accountId === accountUsd || entry.accountId === accountEur)
      && (entry.category === groceries || entry.category === transport),
    )).toBe(true);

    const filteredCount = await readCountLabel(page);
    expect(filteredCount.shown).toBe(3);
    expect(filteredCount.total).toBe(3);

    const clearGroceriesResponse = await waitForTransactionsResponse(page, async () => {
      await categoryPopover.getByLabel(groceries, { exact: true }).click();
    });
    expectSortedQueryValues(clearGroceriesResponse.url(), "categories", [transport]);
    const transportOnlyBody = await clearGroceriesResponse.json() as TransactionsResponseBody;
    expect(transportOnlyBody.total).toBe(2);
    expect(transportOnlyBody.entries.every((entry) => entry.category === transport)).toBe(true);

    const clearTransportResponse = await waitForTransactionsResponse(page, async () => {
      await categoryPopover.getByLabel(transport, { exact: true }).click();
    });
    expectSortedQueryValues(clearTransportResponse.url(), "categories", []);

    await page.keyboard.press("Escape");
    await categoryTrigger.click();
    await expect(categorySearch).toHaveValue("");
    await page.keyboard.press("Escape");

    await accountTrigger.click();
    const clearUsdResponse = await waitForTransactionsResponse(page, async () => {
      await page.getByTestId("transactions-account-filter-popover").getByLabel(accountUsd, { exact: true }).click();
    });
    expectSortedQueryValues(clearUsdResponse.url(), "accountIds", [accountEur]);

    const clearEurResponse = await waitForTransactionsResponse(page, async () => {
      await page.getByTestId("transactions-account-filter-popover").getByLabel(accountEur, { exact: true }).click();
    });
    expectSortedQueryValues(clearEurResponse.url(), "accountIds", []);

    const resetBody = await clearEurResponse.json() as TransactionsResponseBody;
    const resetCount = await readCountLabel(page);
    expect(resetBody.total).toBe(initialCount.total);
    expect(resetCount.total).toBe(initialCount.total);
    expect(resetCount.shown).toBe(initialCount.shown);
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

async function setLocaleCookie(page: Page, baseURL: string, locale: string): Promise<void> {
  const domain = new URL(baseURL).hostname;
  await page.context().addCookies([
    { name: "locale", value: locale, domain, path: "/", httpOnly: false, secure: true, sameSite: "Lax" },
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
