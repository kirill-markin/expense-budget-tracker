import { expect, test, type Page, type Response } from "@playwright/test";

import type { BudgetGridResult, BudgetRow } from "@/server/budget/getBudgetGrid";

type CreatedAdjustment = Readonly<{
  adjustmentId: string;
  month: string;
  direction: "income" | "spend";
  category: string;
  amount: number;
  note: string | null;
}>;

type Deferred = Readonly<{
  promise: Promise<void>;
  resolve: () => void;
}>;

const createDeferred = (): Deferred => {
  let resolvePromise = (): void => {
    throw new Error("Deferred resolver was used before initialization");
  };
  const promise = new Promise<void>((resolve): void => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
};

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

const requestMainContentRefresh = async (
  page: Page,
  version: number,
): Promise<void> => {
  await page.evaluate((nextVersion): void => {
    const channel = new BroadcastChannel("expense-tracker-main-content-invalidation");
    channel.postMessage({
      type: "main_content_invalidation",
      workspaceId: "",
      version: nextVersion,
      sourceId: "budget-base-e2e",
      emittedAt: Date.now(),
    });
    channel.close();
  }, version);
};

const isBudgetGridRangeResponse = (
  response: Response,
  monthFrom: string,
  monthTo: string,
): boolean => {
  const url = new URL(response.url());
  return url.pathname === "/api/budget-grid"
    && url.searchParams.get("monthFrom") === monthFrom
    && url.searchParams.get("monthTo") === monthTo
    && response.request().method() === "GET";
};

const delayFirstBudgetBaseSave = async (
  page: Page,
): Promise<Readonly<{
  captured: Promise<void>;
  release: () => void;
}>> => {
  const captured = createDeferred();
  const gate = createDeferred();
  let requestDelayed = false;
  await page.route("**/api/budget-plan", async (route): Promise<void> => {
    const request = route.request();
    if (
      requestDelayed
      || request.method() !== "POST"
      || new URL(request.url()).pathname !== "/api/budget-plan"
    ) {
      await route.continue();
      return;
    }
    requestDelayed = true;
    const response = await route.fetch();
    if (!response.ok()) {
      throw new Error(`Delayed Base save failed with HTTP ${response.status()}`);
    }
    captured.resolve();
    await gate.promise;
    await route.fulfill({ response });
  });
  return { captured: captured.promise, release: gate.resolve };
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

test("acknowledges the current Base after a stale response reopens its pending editor", async ({ page, baseURL }) => {
  if (baseURL === undefined) throw new Error("Local Demo Playwright baseURL is required");
  await setDemoCookies(page, baseURL, "en");
  await page.goto("/budget", { waitUntil: "domcontentloaded" });

  const editorId = await getEditorId(page, "spend", "Groceries", 0);
  const month = editorId.split(":")[1];
  if (month === undefined) {
    throw new Error(`Cannot read month from editor ID "${editorId}"`);
  }
  const openButton = page.getByTestId(`budget-plan-open-${editorId}`);
  const baseInput = page.getByTestId(`budget-plan-base-input-${editorId}`);
  const popover = page.getByTestId(`budget-plan-popover-${editorId}`);
  await openButton.click();
  const originalBase = Number(await baseInput.inputValue());
  const originalPlanText = await openButton.textContent();
  if (originalPlanText === null) {
    throw new Error(`Cannot read plan button ${editorId}`);
  }
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);

  const visibleMonthFrom = offsetMonth(month, -6);
  const visibleMonthTo = offsetMonth(month, 12);
  const staleRangeCaptured = createDeferred();
  const staleRangeGate = createDeferred();
  await page.route("**/api/budget-grid?*", async (route): Promise<void> => {
    const url = new URL(route.request().url());
    if (
      url.searchParams.get("monthFrom") !== visibleMonthFrom
      || url.searchParams.get("monthTo") !== visibleMonthTo
    ) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    staleRangeCaptured.resolve();
    await staleRangeGate.promise;
    await route.fulfill({ response });
  });

  const staleRangeResponse = page.waitForResponse((response): boolean => (
    isBudgetGridRangeResponse(
      response,
      visibleMonthFrom,
      visibleMonthTo,
    )
  ));
  await requestMainContentRefresh(page, 1);
  await staleRangeCaptured.promise;

  const delayedBase = await delayFirstBudgetBaseSave(page);
  const savedBase = originalBase + 211;
  await openButton.click();
  await baseInput.fill(String(savedBase));
  await page.keyboard.press("Enter");
  await delayedBase.captured;
  await expect(popover).toHaveCount(0);
  await expect(page.getByTestId("budget-sync-status")).toHaveCount(1);
  await expect(openButton).not.toHaveText(originalPlanText);

  staleRangeGate.resolve();
  expect((await staleRangeResponse).ok()).toBe(true);
  await expect(openButton).toHaveText(originalPlanText);
  await openButton.click();
  await expect(baseInput).toHaveValue(String(originalBase));

  delayedBase.release();
  await expect(page.getByTestId("budget-sync-status")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  await openButton.click();
  await expect(baseInput).toHaveValue(String(savedBase));
});

test("publishes successful Fill targets through captured range generations", async ({ page, baseURL }) => {
  if (baseURL === undefined) throw new Error("Local Demo Playwright baseURL is required");
  await setDemoCookies(page, baseURL, "en");
  await page.goto("/budget", { waitUntil: "domcontentloaded" });

  const sourceEditorId = await getEditorId(page, "spend", "Groceries", 0);
  const sourceMonth = sourceEditorId.split(":")[1];
  if (sourceMonth === undefined) {
    throw new Error(`Cannot read month from editor ID "${sourceEditorId}"`);
  }
  await page.getByTestId(`budget-plan-open-${sourceEditorId}`).click();
  await page.keyboard.press("Escape");
  await expect(
    page.getByTestId(`budget-plan-popover-${sourceEditorId}`),
  ).toHaveCount(0);
  const targetMonth = offsetMonth(sourceMonth, 1);
  const targetEditorId = `budget-plan:${targetMonth}:spend:Groceries`;
  const targetOpenButton = page.getByTestId(`budget-plan-open-${targetEditorId}`);
  const targetPlanCell = page.getByTestId(`budget-plan-cell-${targetEditorId}`);
  const delayedBase = await delayFirstBudgetBaseSave(page);

  await targetOpenButton.click();
  const targetBaseInput = page.getByTestId(
    `budget-plan-base-input-${targetEditorId}`,
  );
  const originalTargetBase = Number(await targetBaseInput.inputValue());
  const pendingTargetBase = originalTargetBase + 73;
  const filledBase = pendingTargetBase + 137;
  await targetBaseInput.fill(String(pendingTargetBase));
  await page.keyboard.press("Enter");
  await delayedBase.captured;
  await expect(
    page.getByTestId(`budget-plan-popover-${targetEditorId}`),
  ).toHaveCount(0);
  await expect(page.getByTestId("budget-sync-status")).toHaveCount(1);

  const visibleMonthFrom = offsetMonth(sourceMonth, -6);
  const visibleMonthTo = offsetMonth(sourceMonth, 12);
  const staleRangeCaptured = createDeferred();
  const staleRangeGate = createDeferred();
  let rangeRequestCount = 0;
  await page.route("**/api/budget-grid?*", async (route): Promise<void> => {
    const url = new URL(route.request().url());
    if (
      url.searchParams.get("monthFrom") !== visibleMonthFrom
      || url.searchParams.get("monthTo") !== visibleMonthTo
    ) {
      await route.continue();
      return;
    }
    const requestNumber = rangeRequestCount + 1;
    rangeRequestCount = requestNumber;
    const response = await route.fetch();
    const result = await response.json() as BudgetGridResult;
    if (requestNumber === 1) {
      let targetMarked = false;
      const rows = result.rows.map((row): BudgetRow => {
        if (
          row.month !== targetMonth
          || row.direction !== "spend"
          || row.category !== "Groceries"
        ) {
          return row;
        }
        targetMarked = true;
        return {
          ...row,
          hasUnconvertible: !row.hasUnconvertible,
        };
      });
      if (!targetMarked) {
        throw new Error(
          `Cannot mark target row ${targetMonth}/spend/Groceries`,
        );
      }
      staleRangeCaptured.resolve();
      await staleRangeGate.promise;
      await route.fulfill({ response, json: { ...result, rows } });
      return;
    }
    const rows = result.rows.map((row): BudgetRow => (
      row.month === targetMonth
        && row.direction === "spend"
        && row.category === "Groceries"
        ? {
          ...row,
          plannedBase: originalTargetBase,
          planned: originalTargetBase + row.plannedModifier,
        }
        : row
    ));
    await route.fulfill({ response, json: { ...result, rows } });
  });

  const staleRangeResponse = page.waitForResponse((response): boolean => (
    isBudgetGridRangeResponse(
      response,
      visibleMonthFrom,
      visibleMonthTo,
    )
  ));
  await requestMainContentRefresh(page, 1);
  await staleRangeCaptured.promise;

  await page.getByTestId(`budget-plan-open-${sourceEditorId}`).click();
  const sourceBaseInput = page.getByTestId(
    `budget-plan-base-input-${sourceEditorId}`,
  );
  await sourceBaseInput.fill(String(filledBase));
  const acknowledgedFill = page.waitForResponse((response): boolean => (
    response.url().endsWith("/api/budget-plan-fill")
    && response.request().method() === "POST"
    && response.ok()
  ));
  await page.getByTestId(`budget-plan-fill-${sourceEditorId}`).click();
  expect((await acknowledgedFill).ok()).toBe(true);
  delayedBase.release();
  await expect(page.getByTestId("budget-sync-status")).toHaveCount(0);
  const beforeStaleRangeClass = await targetPlanCell.getAttribute("class");
  if (beforeStaleRangeClass === null) {
    throw new Error(`Cannot read target cell ${targetEditorId}`);
  }
  staleRangeGate.resolve();
  expect((await staleRangeResponse).ok()).toBe(true);
  await expect(targetPlanCell).not.toHaveAttribute(
    "class",
    beforeStaleRangeClass,
  );
  const staleRangeClass = await targetPlanCell.getAttribute("class");
  if (staleRangeClass === null) {
    throw new Error(`Cannot read updated target cell ${targetEditorId}`);
  }

  await targetOpenButton.click();
  await expect(targetBaseInput).toHaveValue(String(filledBase));
  await page.keyboard.press("Escape");

  const newerRangeResponse = page.waitForResponse((response): boolean => (
    isBudgetGridRangeResponse(
      response,
      visibleMonthFrom,
      visibleMonthTo,
    )
  ));
  await requestMainContentRefresh(page, 2);
  expect((await newerRangeResponse).ok()).toBe(true);
  await expect(targetPlanCell).not.toHaveAttribute("class", staleRangeClass);
  await targetOpenButton.click();
  await expect(targetBaseInput).toHaveValue(String(originalTargetBase));
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
