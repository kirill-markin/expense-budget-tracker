import { expect, test, type Page } from "@playwright/test";

const setDemoCookies = async (page: Page, baseURL: string): Promise<void> => {
  const origin = new URL(baseURL);
  await page.context().addCookies([
    { name: "demo", value: "true", domain: origin.hostname, path: "/", sameSite: "Lax" },
    { name: "locale", value: "en", domain: origin.hostname, path: "/", sameSite: "Lax" },
  ]);
};

test("keeps the invalid transaction amount editor as the only active editor", async ({ page, baseURL }) => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }
  await setDemoCookies(page, baseURL);
  await page.goto("/transactions", { waitUntil: "domcontentloaded" });

  const amountCells = page.locator('td[data-testid^="transaction-amount-"]');
  await expect(amountCells).not.toHaveCount(0, { timeout: 15_000 });
  const amountCellCount = await amountCells.count();
  expect(amountCellCount).toBeGreaterThan(1);

  const firstCell = amountCells.nth(0);
  const secondCell = amountCells.nth(1);
  const firstCellTestId = await firstCell.getAttribute("data-testid");
  const secondCellTestId = await secondCell.getAttribute("data-testid");
  if (firstCellTestId === null || secondCellTestId === null) {
    throw new Error("Transaction amount cells are missing their stable test IDs");
  }
  const firstEntryId = firstCellTestId.slice("transaction-amount-".length);
  const secondEntryId = secondCellTestId.slice("transaction-amount-".length);

  await firstCell.click();
  const firstInput = page.getByTestId(`transaction-amount-input-${firstEntryId}`);
  await expect(firstInput).toBeVisible();
  await firstInput.fill("invalid amount");

  await secondCell.click();

  await expect(firstInput).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByTestId(`transaction-amount-input-${secondEntryId}`)).toHaveCount(0);
  await expect(page.locator('[data-testid^="transaction-amount-input-"]')).toHaveCount(1);
});

test("reopens a transaction amount editor from its latest committed value", async ({ page, baseURL }) => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }
  await setDemoCookies(page, baseURL);
  await page.goto("/transactions", { waitUntil: "domcontentloaded" });

  const amountCell = page.locator('td[data-testid^="transaction-amount-"]').first();
  await expect(amountCell).toBeVisible({ timeout: 15_000 });
  const amountCellTestId = await amountCell.getAttribute("data-testid");
  if (amountCellTestId === null) {
    throw new Error("Transaction amount cell is missing its stable test ID");
  }
  const entryId = amountCellTestId.slice("transaction-amount-".length);
  const amountInput = page.getByTestId(`transaction-amount-input-${entryId}`);

  await amountCell.click();
  await amountInput.fill("123");
  const updateResponsePromise = page.waitForResponse((response): boolean =>
    response.url().endsWith("/api/transactions/update")
      && response.request().method() === "POST");
  await amountInput.press("Enter");
  const updateResponse = await updateResponsePromise;
  expect(updateResponse.ok()).toBe(true);
  await expect(amountInput).toHaveCount(0);

  await amountCell.click();
  await expect(amountInput).toHaveValue("123");
});

test("keeps the invalid budget plan popover as the only active popover", async ({ page, baseURL }) => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }
  await setDemoCookies(page, baseURL);
  await page.goto("/budget", { waitUntil: "domcontentloaded" });

  const planOpenButtons = page.locator('[data-testid^="budget-plan-open-budget-plan:"]');
  await expect(planOpenButtons).not.toHaveCount(0);
  const planOpenButtonCount = await planOpenButtons.count();
  expect(planOpenButtonCount).toBeGreaterThan(1);

  const firstOpenButton = planOpenButtons.nth(0);
  const secondOpenButton = planOpenButtons.nth(1);
  const firstOpenButtonTestId = await firstOpenButton.getAttribute("data-testid");
  if (firstOpenButtonTestId === null) {
    throw new Error("First budget plan button is missing its stable test ID");
  }
  const firstEditorId = firstOpenButtonTestId.slice("budget-plan-open-".length);

  await firstOpenButton.click();
  const firstInput = page.getByTestId(`budget-plan-base-input-${firstEditorId}`);
  await expect(firstInput).toBeVisible();
  await firstInput.fill("invalid amount");

  await secondOpenButton.click();

  const baseError = page.getByTestId(`budget-plan-base-error-${firstEditorId}`);
  await expect(firstInput).toHaveAttribute("aria-invalid", "true");
  await expect(firstInput).toBeEnabled();
  await expect(firstInput).toBeFocused();
  await expect(baseError).toHaveText("Enter a valid number in the selected format.");
  const describedBy = await firstInput.getAttribute("aria-describedby");
  if (describedBy === null) {
    throw new Error("Invalid Budget Base input must describe its validation error");
  }
  await expect(baseError).toHaveAttribute("id", describedBy);
  await expect(page.locator('[data-testid^="budget-plan-base-input-budget-plan:"]')).toHaveCount(1);
});
