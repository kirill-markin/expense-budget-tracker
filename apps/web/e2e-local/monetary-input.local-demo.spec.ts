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

test("keeps the invalid budget plan popover as the only active popover", async ({ page, baseURL }) => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }
  await setDemoCookies(page, baseURL);
  await page.goto("/budget", { waitUntil: "domcontentloaded" });

  const planCells = page.locator('[data-testid^="budget-plan-cell-budget-plan:"]');
  await expect(planCells).not.toHaveCount(0);
  const planCellCount = await planCells.count();
  expect(planCellCount).toBeGreaterThan(1);

  const firstCell = planCells.nth(0);
  const secondCell = planCells.nth(1);
  const firstCellTestId = await firstCell.getAttribute("data-testid");
  if (firstCellTestId === null) {
    throw new Error("First budget plan cell is missing its stable test ID");
  }
  const firstEditorId = firstCellTestId.slice("budget-plan-cell-".length);

  await firstCell.click();
  const firstInput = page.getByTestId(`budget-plan-modifier-input-${firstEditorId}`);
  await expect(firstInput).toBeVisible();
  await firstInput.fill("invalid amount");

  await secondCell.click();

  await expect(firstInput).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator('[data-testid^="budget-plan-modifier-input-budget-plan:"]')).toHaveCount(1);
});
