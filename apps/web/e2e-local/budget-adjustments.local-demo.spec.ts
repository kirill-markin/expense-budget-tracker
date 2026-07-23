import { expect, test, type Page } from "@playwright/test";

type CreatedAdjustment = Readonly<{
  adjustmentId: string;
  month: string;
  direction: "income" | "spend";
  category: string;
  amount: number;
  note: string | null;
}>;

const setDemoCookies = async (
  page: Page,
  baseURL: string,
  locale: "en" | "ar",
): Promise<void> => {
  const origin = new URL(baseURL);
  await page.context().addCookies([
    { name: "demo", value: "true", domain: origin.hostname, path: "/", sameSite: "Lax" },
    { name: "locale", value: locale, domain: origin.hostname, path: "/", sameSite: "Lax" },
  ]);
};

const offsetMonth = (month: string, offset: number): string => {
  const date = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + offset, 1));
  return `${String(date.getUTCFullYear()).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
};

const getEditorId = async (
  page: Page,
  direction: "income" | "spend",
  category: string,
  occurrence: number,
): Promise<string> => {
  const button = page.locator(
    `[data-testid^="budget-plan-open-budget-plan:"][data-testid$=":${direction}:${category}"]`,
  ).nth(occurrence);
  await expect(button).toBeVisible({ timeout: 15_000 });
  const testId = await button.getAttribute("data-testid");
  if (testId === null) {
    throw new Error(`${category} budget plan trigger is missing its stable test ID`);
  }
  return testId.slice("budget-plan-open-".length);
};

test("creates, autosaves, moves, and deletes normalized adjustment rows", async ({ page, baseURL }) => {
  if (baseURL === undefined) throw new Error("Local Demo Playwright baseURL is required");
  await setDemoCookies(page, baseURL, "en");
  await page.goto("/budget", { waitUntil: "domcontentloaded" });

  const editorId = await getEditorId(page, "spend", "Groceries", 0);
  const month = editorId.split(":")[1];
  if (month === undefined) throw new Error(`Cannot read month from editor ID "${editorId}"`);
  const destinationMonth = offsetMonth(month, 2);
  const openButton = page.getByTestId(`budget-plan-open-${editorId}`);
  await openButton.click();

  const firstAmountInput = page.getByTestId(
    "budget-adjustment-amount-demo-adjustment-groceries-seasonal",
  );
  const firstNoteInput = page.getByTestId(
    "budget-adjustment-note-demo-adjustment-groceries-seasonal",
  );
  await expect(firstAmountInput).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(firstNoteInput).toBeFocused();

  const baseInput = page.getByTestId(`budget-plan-base-input-${editorId}`);
  const originalBase = await baseInput.inputValue();
  let baseRequestCount = 0;
  page.on("request", (request): void => {
    if (request.url().endsWith("/api/budget-plan") && request.method() === "POST") {
      baseRequestCount += 1;
    }
  });
  await baseInput.fill("987");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId(`budget-plan-popover-${editorId}`)).toHaveCount(0);
  await expect(openButton).toBeFocused();
  await openButton.click();
  await expect(baseInput).toHaveValue(originalBase);
  expect(baseRequestCount).toBe(0);

  const addButton = page.getByTestId(`budget-adjustment-add-${editorId}`);
  const createResponsePromise = page.waitForResponse((response): boolean =>
    response.url().endsWith("/api/budget-adjustments")
      && response.request().method() === "POST");
  await addButton.click();
  const createResponse = await createResponsePromise;
  expect(createResponse.ok()).toBe(true);
  const created = await createResponse.json() as CreatedAdjustment;
  expect(created).toMatchObject({
    month,
    direction: "spend",
    category: "Groceries",
    amount: 0,
    note: null,
  });

  const adjustmentId = created.adjustmentId;
  let locationPatchCount = 0;
  page.on("request", (request): void => {
    if (
      !request.url().includes(`/api/budget-adjustments/${adjustmentId}`)
      || request.method() !== "PATCH"
    ) {
      return;
    }
    const body: unknown = request.postDataJSON();
    if (
      typeof body === "object"
      && body !== null
      && ("month" in body || "category" in body)
    ) {
      locationPatchCount += 1;
    }
  });
  const row = page.getByTestId(`budget-adjustment-row-${adjustmentId}`);
  const amountInput = page.getByTestId(`budget-adjustment-amount-${adjustmentId}`);
  const noteInput = page.getByTestId(`budget-adjustment-note-${adjustmentId}`);
  const monthInput = page.getByTestId(`budget-adjustment-month-${adjustmentId}`);
  const categoryInput = page.getByTestId(`budget-adjustment-category-${adjustmentId}`);
  const nextMonthButton = page.getByTestId(
    `budget-adjustment-month-next-${adjustmentId}`,
  );
  await expect(row).toBeVisible();
  await expect(amountInput).toHaveValue("");

  await amountInput.fill("not-an-integer");
  await nextMonthButton.click();
  await expect(row).toBeVisible();
  await expect(amountInput).toBeFocused();
  await expect(monthInput).toHaveValue(month);
  await monthInput.fill(destinationMonth);
  await expect(row).toBeVisible();
  await expect(amountInput).toBeFocused();
  await expect(monthInput).toHaveValue(month);
  await page.waitForTimeout(700);
  expect(locationPatchCount).toBe(0);

  const amountAutosave = page.waitForResponse((response): boolean =>
    response.url().includes(`/api/budget-adjustments/${adjustmentId}`)
      && response.request().method() === "PATCH");
  await amountInput.fill("125");
  expect((await amountAutosave).ok()).toBe(true);

  await noteInput.fill("Annual stock-up");
  await noteInput.press("Enter");
  await noteInput.type("Second line");
  await expect(noteInput).toHaveValue("Annual stock-up\nSecond line");
  const noteBlurSave = page.waitForResponse((response): boolean =>
    response.url().includes(`/api/budget-adjustments/${adjustmentId}`)
      && response.request().method() === "PATCH");
  await amountInput.click();
  expect((await noteBlurSave).ok()).toBe(true);

  const blankAmountSave = page.waitForResponse((response): boolean =>
    response.url().includes(`/api/budget-adjustments/${adjustmentId}`)
      && response.request().method() === "PATCH");
  await amountInput.fill("");
  await amountInput.press("Enter");
  const blankAmountResponse = await blankAmountSave;
  expect(blankAmountResponse.ok()).toBe(true);
  expect(blankAmountResponse.request().postDataJSON()).toEqual({ amount: 0 });
  await expect(row).toBeVisible();

  const monthMove = page.waitForResponse((response): boolean =>
    response.url().includes(`/api/budget-adjustments/${adjustmentId}`)
      && response.request().method() === "PATCH");
  await monthInput.fill(destinationMonth);
  expect((await monthMove).ok()).toBe(true);
  await expect(row).toHaveCount(0);
  await expect(addButton).toBeFocused();
  expect(locationPatchCount).toBe(1);

  const destinationEditorId = `budget-plan:${destinationMonth}:spend:Groceries`;
  await page.getByTestId(`budget-plan-open-${destinationEditorId}`).click();
  await expect(row).toBeVisible();
  await expect(monthInput).toHaveValue(destinationMonth);
  const destinationAddButton = page.getByTestId(
    `budget-adjustment-add-${destinationEditorId}`,
  );
  const previousMonthButton = page.getByTestId(
    `budget-adjustment-month-previous-${adjustmentId}`,
  );
  await noteInput.fill("x".repeat(2001));
  await previousMonthButton.click();
  await expect(row).toBeVisible();
  await expect(noteInput).toBeFocused();
  await expect(monthInput).toHaveValue(destinationMonth);
  await categoryInput.selectOption("Dining");
  await expect(row).toBeVisible();
  await expect(noteInput).toBeFocused();
  await expect(categoryInput).toHaveValue("Groceries");
  await page.waitForTimeout(700);
  expect(locationPatchCount).toBe(1);

  await noteInput.fill("Annual stock-up\nSecond line");
  await amountInput.click();
  await expect(noteInput).toHaveValue("Annual stock-up\nSecond line");

  const categoryMove = page.waitForResponse((response): boolean =>
    response.url().includes(`/api/budget-adjustments/${adjustmentId}`)
      && response.request().method() === "PATCH");
  await categoryInput.selectOption("Dining");
  expect((await categoryMove).ok()).toBe(true);
  await expect(row).toHaveCount(0);
  await expect(destinationAddButton).toBeFocused();
  expect(locationPatchCount).toBe(2);

  const diningEditorId = `budget-plan:${destinationMonth}:spend:Dining`;
  await page.getByTestId(`budget-plan-open-${diningEditorId}`).click();
  await expect(row).toBeVisible();
  await page.getByTestId(`budget-adjustment-delete-${adjustmentId}`).click();
  const dialog = page.getByTestId(`budget-adjustment-delete-dialog-${adjustmentId}`);
  await expect(dialog).toContainText("Annual stock-up");
  await page.getByTestId(`budget-adjustment-delete-cancel-${adjustmentId}`).click();
  await expect(dialog).toHaveCount(0);

  await page.getByTestId(`budget-adjustment-delete-${adjustmentId}`).click();
  const deleteResponsePromise = page.waitForResponse((response): boolean =>
    response.url().includes(`/api/budget-adjustments/${adjustmentId}`)
      && response.request().method() === "DELETE");
  await page.getByTestId(`budget-adjustment-delete-confirm-${adjustmentId}`).click();
  expect((await deleteResponsePromise).ok()).toBe(true);
  await expect(row).toHaveCount(0);
  await expect(dialog).toHaveCount(0);

  await page.keyboard.press("Escape");
  await page.getByTestId(`budget-plan-open-${diningEditorId}`).click();
  await expect(page.getByTestId(`budget-adjustment-add-${diningEditorId}`)).toBeFocused();
});

test("keeps the adjustment editor usable on mobile RTL", async ({ page, baseURL }) => {
  if (baseURL === undefined) throw new Error("Local Demo Playwright baseURL is required");
  await page.setViewportSize({ width: 390, height: 844 });
  await setDemoCookies(page, baseURL, "ar");
  await page.goto("/budget", { waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  const chatCloseButton = page.getByTestId("chat-sidebar-close");
  if (await chatCloseButton.isVisible()) await chatCloseButton.click();

  const editorId = await getEditorId(page, "spend", "Groceries", 0);
  await page.getByTestId(`budget-plan-open-${editorId}`).click();
  const popover = page.getByTestId(`budget-plan-popover-${editorId}`);
  const amountInput = page.getByTestId(
    "budget-adjustment-amount-demo-adjustment-groceries-seasonal",
  );
  const monthInput = page.getByTestId(
    "budget-adjustment-month-demo-adjustment-groceries-seasonal",
  );
  const deleteButton = page.getByTestId(
    "budget-adjustment-delete-demo-adjustment-groceries-seasonal",
  );
  const popoverBox = await popover.boundingBox();
  const amountBox = await amountInput.boundingBox();
  const monthBox = await monthInput.boundingBox();
  const deleteBox = await deleteButton.boundingBox();
  if (popoverBox === null || amountBox === null || monthBox === null || deleteBox === null) {
    throw new Error("Responsive adjustment controls must have measurable bounds");
  }
  expect(popoverBox.x).toBeGreaterThanOrEqual(0);
  expect(popoverBox.x + popoverBox.width).toBeLessThanOrEqual(390);
  expect(amountBox.height).toBeGreaterThanOrEqual(44);
  expect(monthBox.height).toBeGreaterThanOrEqual(44);
  expect(deleteBox.height).toBeGreaterThanOrEqual(44);
});
