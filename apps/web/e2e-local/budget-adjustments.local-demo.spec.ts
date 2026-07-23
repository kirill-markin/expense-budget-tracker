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

type ModeReloadCapture = Readonly<{
  started: Promise<void>;
  getRequestCount: () => number;
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

const readBudgetBasePlannedValue = (requestBody: unknown): number => {
  if (
    typeof requestBody !== "object"
    || requestBody === null
    || !("plannedValue" in requestBody)
    || typeof requestBody.plannedValue !== "number"
  ) {
    throw new Error("Budget Base request is missing a numeric plannedValue");
  }
  return requestBody.plannedValue;
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
    const message = {
      type: "main_content_invalidation",
      workspaceId: "",
      version: nextVersion,
      sourceId: "budget-base-e2e",
      emittedAt: Date.now(),
    };
    window.dispatchEvent(new StorageEvent("storage", {
      key: "expense-tracker-main-content-invalidation",
      newValue: JSON.stringify(message),
    }));
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

const isBudgetGridResponse = (response: Response): boolean =>
  new URL(response.url()).pathname === "/api/budget-grid"
  && response.request().method() === "GET";

const gotoBudgetAndWaitForGrid = async (page: Page): Promise<void> => {
  const initialBudgetGridResponse = page.waitForResponse(isBudgetGridResponse);
  await page.goto("/budget", { waitUntil: "domcontentloaded" });
  expect((await initialBudgetGridResponse).ok()).toBe(true);
};

const captureModeReload = async (page: Page): Promise<ModeReloadCapture> => {
  const started = createDeferred();
  let requestCount = 0;
  await page.route("**/budget", async (route): Promise<void> => {
    const request = route.request();
    if (
      !request.isNavigationRequest()
      || new URL(request.url()).pathname !== "/budget"
    ) {
      await route.continue();
      return;
    }
    requestCount += 1;
    started.resolve();
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><body data-testid=\"mode-transition-complete\"></body>",
    });
  });
  return {
    started: started.promise,
    getRequestCount: (): number => requestCount,
  };
};

const adjustmentRequestFieldEquals = (
  response: Response,
  field: "category" | "month",
  expectedValue: string,
): boolean => {
  const requestBody: unknown = response.request().postDataJSON();
  if (typeof requestBody !== "object" || requestBody === null) return false;
  if (field === "category") {
    return "category" in requestBody
      && requestBody.category === expectedValue;
  }
  return "month" in requestBody
    && requestBody.month === expectedValue;
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
  test.slow();
  if (baseURL === undefined) throw new Error("Local Demo Playwright baseURL is required");
  await setDemoCookies(page, baseURL, "en");
  await gotoBudgetAndWaitForGrid(page);

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
  await baseInput.press("Escape");
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

  await page.evaluate((params): void => {
    const monthControl = document.querySelector(
      `[data-testid="${params.monthTestId}"]`,
    );
    const baseControl = document.querySelector(
      `[data-testid="${params.baseTestId}"]`,
    );
    if (!(monthControl instanceof HTMLInputElement)) {
      throw new Error("Budget adjustment Month control is not an input");
    }
    if (!(baseControl instanceof HTMLInputElement)) {
      throw new Error("Budget Base control is not an input");
    }
    const setInputValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    if (setInputValue === undefined) {
      throw new Error("HTML input value setter is unavailable");
    }
    setInputValue.call(monthControl, "");
    monthControl.dispatchEvent(new Event("input", { bubbles: true }));
    setInputValue.call(monthControl, params.month);
    monthControl.dispatchEvent(new Event("input", { bubbles: true }));
    baseControl.focus();
  }, {
    monthTestId: `budget-adjustment-month-${adjustmentId}`,
    baseTestId: `budget-plan-base-input-${editorId}`,
    month,
  });
  await page.waitForTimeout(50);
  await expect(baseInput).toBeFocused();
  await expect(monthInput).toHaveValue(month);
  await expect(monthInput).toHaveAttribute("aria-invalid", "false");
  await expect(monthInput).toHaveJSProperty("validationMessage", "");
  expect(locationPatchCount).toBe(0);

  await monthInput.fill("");
  await categoryInput.selectOption("Dining");
  await expect(monthInput).toBeFocused();
  await expect(monthInput).toHaveAttribute("aria-invalid", "true");
  await expect(categoryInput).toHaveAttribute("aria-invalid", "false");
  await expect(categoryInput).toHaveJSProperty("validationMessage", "");
  await categoryInput.selectOption("Groceries");
  await monthInput.fill(month);
  await expect(monthInput).toBeFocused();
  await expect(monthInput).toHaveAttribute("aria-invalid", "false");
  await expect(categoryInput).toHaveAttribute("aria-invalid", "false");
  await expect(monthInput).toHaveJSProperty("validationMessage", "");
  await expect(categoryInput).toHaveJSProperty("validationMessage", "");
  await page.waitForTimeout(700);
  expect(locationPatchCount).toBe(0);

  await categoryInput.evaluate((element): void => {
    if (!(element instanceof HTMLSelectElement)) {
      throw new Error("Budget adjustment Category control is not a select");
    }
    element.focus();
    element.value = "";
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(row).toBeVisible();
  await expect(categoryInput).toBeFocused();
  await expect(categoryInput).toHaveAttribute("aria-invalid", "true");
  await page.waitForTimeout(700);
  expect(locationPatchCount).toBe(0);

  await categoryInput.selectOption("Groceries");
  await expect(row).toBeVisible();
  await expect(categoryInput).toBeFocused();
  await expect(categoryInput).toHaveAttribute("aria-invalid", "false");
  await page.waitForTimeout(700);
  expect(locationPatchCount).toBe(0);

  const monthMoveStarted = createDeferred();
  const monthMoveGate = createDeferred();
  await page.route(
    `**/api/budget-adjustments/${adjustmentId}`,
    async (route): Promise<void> => {
      const body: unknown = route.request().postDataJSON();
      if (
        route.request().method() !== "PATCH"
        || typeof body !== "object"
        || body === null
        || !("month" in body)
      ) {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      monthMoveStarted.resolve();
      await monthMoveGate.promise;
      await route.fulfill({ response });
    },
  );
  const monthMove = page.waitForResponse((response): boolean =>
    response.url().includes(`/api/budget-adjustments/${adjustmentId}`)
      && response.request().method() === "PATCH"
      && adjustmentRequestFieldEquals(response, "month", destinationMonth));
  await monthInput.fill(destinationMonth);
  await monthMoveStarted.promise;
  await expect(row).toBeVisible();
  await expect(monthInput).toHaveValue(destinationMonth);
  await expect(monthInput).toBeFocused();
  await expect(addButton).not.toBeFocused();
  expect(baseRequestCount).toBe(0);
  await baseInput.click();
  await expect(baseInput).toBeFocused();
  monthMoveGate.resolve();
  expect((await monthMove).ok()).toBe(true);
  await page.unroute(`**/api/budget-adjustments/${adjustmentId}`);
  await expect(row).toHaveCount(0);
  await expect(baseInput).toBeFocused();
  await expect(addButton).not.toBeFocused();
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
      && response.request().method() === "PATCH"
      && adjustmentRequestFieldEquals(response, "category", "Dining"));
  await categoryInput.selectOption("Dining");
  expect((await categoryMove).ok()).toBe(true);
  await expect(row).toHaveCount(0);
  await expect(destinationAddButton).toBeFocused();
  expect(locationPatchCount).toBe(2);

  const diningEditorId = `budget-plan:${destinationMonth}:spend:Dining`;
  await destinationAddButton.press("Escape");
  await expect(
    page.getByTestId(`budget-plan-popover-${destinationEditorId}`),
  ).toHaveCount(0);
  await page.getByTestId(`budget-plan-open-${diningEditorId}`).click();
  await expect(row).toBeVisible();
  await page.getByTestId(`budget-adjustment-delete-${adjustmentId}`).click();
  const dialog = page.getByTestId(`budget-adjustment-delete-dialog-${adjustmentId}`);
  await expect(dialog).toContainText("Annual stock-up");
  await page.getByTestId(`budget-adjustment-delete-cancel-${adjustmentId}`).click();
  await expect(dialog).toHaveCount(0);
  expect(baseRequestCount).toBe(0);

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

test("keeps a delayed move editable in its source when a newer location draft is invalid", async ({ page, baseURL }) => {
  test.slow();
  if (baseURL === undefined) throw new Error("Local Demo Playwright baseURL is required");
  await setDemoCookies(page, baseURL, "en");
  await gotoBudgetAndWaitForGrid(page);

  const adjustmentId = "demo-adjustment-groceries-seasonal";
  const sourceEditorId = await getEditorId(page, "spend", "Groceries", 0);
  const sourceMonth = sourceEditorId.split(":")[1];
  if (sourceMonth === undefined) {
    throw new Error(`Cannot read month from editor ID "${sourceEditorId}"`);
  }
  const destinationMonth = offsetMonth(sourceMonth, 2);
  const destinationEditorId =
    `budget-plan:${destinationMonth}:spend:Groceries`;
  const sourcePopover = page.getByTestId(
    `budget-plan-popover-${sourceEditorId}`,
  );
  const destinationPopover = page.getByTestId(
    `budget-plan-popover-${destinationEditorId}`,
  );
  const moveStarted = createDeferred();
  const moveGate = createDeferred();
  await page.route(
    `**/api/budget-adjustments/${adjustmentId}`,
    async (route): Promise<void> => {
      if (route.request().method() !== "PATCH") {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      moveStarted.resolve();
      await moveGate.promise;
      await route.fulfill({ response });
    },
  );

  await page.getByTestId(`budget-plan-open-${sourceEditorId}`).click();
  const row = page.getByTestId(`budget-adjustment-row-${adjustmentId}`);
  const monthInput = page.getByTestId(
    `budget-adjustment-month-${adjustmentId}`,
  );
  const categoryInput = page.getByTestId(
    `budget-adjustment-category-${adjustmentId}`,
  );
  const moveResponse = page.waitForResponse((response): boolean =>
    response.url().includes(`/api/budget-adjustments/${adjustmentId}`)
      && response.request().method() === "PATCH"
      && adjustmentRequestFieldEquals(
        response,
        "month",
        destinationMonth,
      ));
  await monthInput.fill(destinationMonth);
  await moveStarted.promise;
  await categoryInput.evaluate((element): void => {
    if (!(element instanceof HTMLSelectElement)) {
      throw new Error("Budget adjustment Category control is not a select");
    }
    element.focus();
    element.value = "";
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(categoryInput).toBeFocused();
  await expect(categoryInput).toHaveAttribute("aria-invalid", "true");

  moveGate.resolve();
  expect((await moveResponse).ok()).toBe(true);
  await page.unroute(`**/api/budget-adjustments/${adjustmentId}`);
  await expect(row).toBeVisible();
  await expect(monthInput).toHaveValue(destinationMonth);
  await expect(categoryInput).toHaveAttribute("aria-invalid", "true");
  await expect(categoryInput).toBeFocused();

  await page.getByTestId(`budget-plan-open-${destinationEditorId}`).click();
  await expect(sourcePopover).toBeVisible();
  await expect(destinationPopover).toHaveCount(0);
  await expect(row).toBeVisible();
  await expect(categoryInput).toBeFocused();

  await categoryInput.selectOption("Groceries");
  await expect(row).toHaveCount(0);
  await expect(
    page.getByTestId(`budget-adjustment-add-${sourceEditorId}`),
  ).toBeFocused();

  await page.getByTestId(`budget-plan-open-${destinationEditorId}`).click();
  await expect(sourcePopover).toHaveCount(0);
  await expect(destinationPopover).toBeVisible();
  await expect(row).toBeVisible();
});

const settleAcknowledgedMoveAfterRetryEdit = async (
  page: Page,
  baseURL: string | undefined,
  retryTrigger: "autosave" | "Enter",
): Promise<void> => {
  if (baseURL === undefined) throw new Error("Local Demo Playwright baseURL is required");
  await setDemoCookies(page, baseURL, "en");
  await gotoBudgetAndWaitForGrid(page);

  const adjustmentId = "demo-adjustment-groceries-seasonal";
  const sourceEditorId = await getEditorId(page, "spend", "Groceries", 0);
  const sourceMonth = sourceEditorId.split(":")[1];
  if (sourceMonth === undefined) {
    throw new Error(`Cannot read month from editor ID "${sourceEditorId}"`);
  }
  const destinationMonth = offsetMonth(sourceMonth, 2);
  const destinationEditorId =
    `budget-plan:${destinationMonth}:spend:Groceries`;
  const sourcePopover = page.getByTestId(
    `budget-plan-popover-${sourceEditorId}`,
  );
  const destinationPopover = page.getByTestId(
    `budget-plan-popover-${destinationEditorId}`,
  );
  const moveStarted = createDeferred();
  const moveGate = createDeferred();
  let patchAttempt = 0;
  let allowRetry = false;
  await page.route(
    `**/api/budget-adjustments/${adjustmentId}`,
    async (route): Promise<void> => {
      if (route.request().method() !== "PATCH") {
        await route.continue();
        return;
      }
      patchAttempt += 1;
      if (patchAttempt === 1) {
        const response = await route.fetch();
        moveStarted.resolve();
        await moveGate.promise;
        await route.fulfill({ response });
        return;
      }
      if (!allowRetry) {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: "Forced follow-up conflict" }),
        });
        return;
      }
      await route.continue();
    },
  );

  await page.getByTestId(`budget-plan-open-${sourceEditorId}`).click();
  await expect(sourcePopover).toBeVisible();
  const row = page.getByTestId(`budget-adjustment-row-${adjustmentId}`);
  const monthInput = page.getByTestId(
    `budget-adjustment-month-${adjustmentId}`,
  );
  const amountInput = page.getByTestId(
    `budget-adjustment-amount-${adjustmentId}`,
  );
  const recoveryButton = page.getByTestId(
    `budget-adjustment-recovery-${adjustmentId}`,
  );
  const moveResponse = page.waitForResponse((response): boolean =>
    response.url().includes(`/api/budget-adjustments/${adjustmentId}`)
      && response.request().method() === "PATCH"
      && adjustmentRequestFieldEquals(
        response,
        "month",
        destinationMonth,
      ));
  const failedFollowUp = page.waitForResponse((response): boolean =>
    response.url().includes(`/api/budget-adjustments/${adjustmentId}`)
      && response.request().method() === "PATCH"
      && response.status() === 409);
  await monthInput.fill(destinationMonth);
  await moveStarted.promise;
  await amountInput.fill("88");
  await expect(amountInput).toBeFocused();
  moveGate.resolve();

  expect((await moveResponse).ok()).toBe(true);
  expect((await failedFollowUp).ok()).toBe(false);
  await expect(row).toBeVisible();
  await expect(monthInput).toHaveValue(destinationMonth);
  await expect(amountInput).toHaveValue("88");
  await expect(amountInput).toBeFocused();
  await expect(recoveryButton).toBeVisible();
  await expect(recoveryButton).toBeEnabled();

  await page.getByTestId(`budget-plan-open-${destinationEditorId}`).click();
  await expect(sourcePopover).toBeVisible();
  await expect(destinationPopover).toHaveCount(0);
  await expect(row).toBeVisible();
  await expect(recoveryButton).toBeEnabled();

  allowRetry = true;
  const retryResponse = page.waitForResponse((response): boolean =>
    response.url().includes(`/api/budget-adjustments/${adjustmentId}`)
      && response.request().method() === "PATCH"
      && response.ok());
  await amountInput.fill("89");
  if (retryTrigger === "Enter") await amountInput.press("Enter");
  expect((await retryResponse).ok()).toBe(true);
  await expect(row).toHaveCount(0);
  await expect(
    page.getByTestId(`budget-adjustment-add-${sourceEditorId}`),
  ).toBeFocused();

  await page.getByTestId(`budget-plan-open-${destinationEditorId}`).click();
  await expect(sourcePopover).toHaveCount(0);
  await expect(destinationPopover).toBeVisible();
  await expect(row).toBeVisible();
  await expect(amountInput).toHaveValue("89");
};

test("settles an acknowledged move after an autosave retry edit", async ({ page, baseURL }) => {
  test.slow();
  await settleAcknowledgedMoveAfterRetryEdit(page, baseURL, "autosave");
});

test("settles an acknowledged move after an Enter retry edit", async ({ page, baseURL }) => {
  test.slow();
  await settleAcknowledgedMoveAfterRetryEdit(page, baseURL, "Enter");
});

test("keeps a one-option Category correction private and blocks unavailable drafts", async ({ page, baseURL }) => {
  test.slow();
  if (baseURL === undefined) throw new Error("Local Demo Playwright baseURL is required");
  await setDemoCookies(page, baseURL, "en");
  await gotoBudgetAndWaitForGrid(page);

  const adjustmentId = "demo-adjustment-groceries-seasonal";
  const editorId = await getEditorId(page, "spend", "Groceries", 0);
  const popover = page.getByTestId(`budget-plan-popover-${editorId}`);
  await page.getByTestId(`budget-plan-open-${editorId}`).click();
  await expect(popover).toBeVisible();

  const categoryInput = page.getByTestId(
    `budget-adjustment-category-${adjustmentId}`,
  );
  const requestedCategories: Array<string> = [];
  await page.route(
    `**/api/budget-adjustments/${adjustmentId}`,
    async (route): Promise<void> => {
      if (route.request().method() !== "PATCH") {
        await route.continue();
        return;
      }
      const requestBody: unknown = route.request().postDataJSON();
      if (
        typeof requestBody !== "object"
        || requestBody === null
        || !("category" in requestBody)
        || typeof requestBody.category !== "string"
      ) {
        throw new Error("Budget adjustment Category PATCH is missing its category");
      }
      requestedCategories.push(requestBody.category);
      await route.continue();
    },
  );

  await categoryInput.evaluate((element): void => {
    if (!(element instanceof HTMLSelectElement)) {
      throw new Error("Budget adjustment Category control is not a select");
    }
    element.focus();
    element.value = "";
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(categoryInput).toHaveValue("");
  await expect(categoryInput).toBeFocused();
  await expect(categoryInput).toHaveAttribute("aria-invalid", "true");
  await expect(popover).toContainText("Choose a category.");

  await categoryInput.press("Enter");
  await page.waitForTimeout(700);
  expect(requestedCategories).toEqual([]);
  await expect(categoryInput).toHaveAttribute("aria-invalid", "true");

  await categoryInput.evaluate((element): void => {
    if (!(element instanceof HTMLSelectElement)) {
      throw new Error("Budget adjustment Category control is not a select");
    }
    for (const option of [...element.options]) {
      if (option.value !== "" && option.value !== "Groceries") option.remove();
    }
    element.value = "";
  });
  expect(await categoryInput.locator("option").evaluateAll(
    (options): ReadonlyArray<Readonly<{ value: string; text: string }>> =>
      options.map((option): Readonly<{ value: string; text: string }> => ({
        value: (option as HTMLOptionElement).value,
        text: option.textContent ?? "",
      })),
  )).toEqual([
    { value: "", text: "" },
    { value: "Groceries", text: "Groceries" },
  ]);
  await expect(categoryInput).toHaveValue("");

  await categoryInput.selectOption("Groceries");
  await expect(categoryInput).toHaveValue("Groceries");
  await expect(categoryInput).toHaveAttribute("aria-invalid", "false");
  await page.waitForTimeout(700);
  expect(requestedCategories).toEqual([]);
});

test("keeps failed adjustment settlement editable and retryable across editor handoff", async ({ page, baseURL }) => {
  test.slow();
  if (baseURL === undefined) throw new Error("Local Demo Playwright baseURL is required");
  await setDemoCookies(page, baseURL, "en");
  await gotoBudgetAndWaitForGrid(page);

  const adjustmentId = "demo-adjustment-groceries-seasonal";
  const editorId = await getEditorId(page, "spend", "Groceries", 0);
  const month = editorId.split(":")[1];
  if (month === undefined) throw new Error(`Cannot read month from editor ID "${editorId}"`);
  const destinationEditorId = `budget-plan:${month}:spend:Dining`;
  const sourcePopover = page.getByTestId(`budget-plan-popover-${editorId}`);
  const destinationPopover = page.getByTestId(
    `budget-plan-popover-${destinationEditorId}`,
  );
  let baseRequestCount = 0;
  page.on("request", (request): void => {
    if (request.url().endsWith("/api/budget-plan") && request.method() === "POST") {
      baseRequestCount += 1;
    }
  });

  let allowPatch = false;
  let delayRecoveryFailure = false;
  const recoveryFailureStarted = createDeferred();
  const recoveryFailureGate = createDeferred();
  await page.route(
    `**/api/budget-adjustments/${adjustmentId}`,
    async (route): Promise<void> => {
      if (route.request().method() !== "PATCH" || allowPatch) {
        await route.continue();
        return;
      }
      if (delayRecoveryFailure) {
        recoveryFailureStarted.resolve();
        await recoveryFailureGate.promise;
      }
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Private forced adjustment failure" }),
      });
    },
  );

  await page.getByTestId(`budget-plan-open-${editorId}`).click();
  const amountInput = page.getByTestId(`budget-adjustment-amount-${adjustmentId}`);
  const recoveryButton = page.getByTestId(
    `budget-adjustment-recovery-${adjustmentId}`,
  );
  const baseInput = page.getByTestId(`budget-plan-base-input-${editorId}`);
  const failedSave = page.waitForResponse((response): boolean =>
    response.url().includes(`/api/budget-adjustments/${adjustmentId}`)
      && response.request().method() === "PATCH"
      && response.status() === 500);
  await amountInput.fill("37");
  await amountInput.press("Enter");
  expect((await failedSave).ok()).toBe(false);
  await expect(recoveryButton).toBeVisible();
  await expect(recoveryButton).toBeEnabled();
  await expect(sourcePopover).toContainText("The adjustment could not be saved.");
  await expect(sourcePopover).not.toContainText("Private forced adjustment failure");
  await expect(amountInput).toBeFocused();

  const focusedRecoveryFailure = page.waitForResponse((response): boolean =>
    response.url().includes(`/api/budget-adjustments/${adjustmentId}`)
      && response.request().method() === "PATCH"
      && response.status() === 500);
  await recoveryButton.click();
  expect((await focusedRecoveryFailure).ok()).toBe(false);
  await expect(recoveryButton).toBeEnabled();
  await expect(amountInput).toBeFocused();

  await page.getByTestId(`budget-plan-open-${destinationEditorId}`).click();
  await expect(sourcePopover).toBeVisible();
  await expect(destinationPopover).toHaveCount(0);
  await expect(recoveryButton).toBeEnabled();

  await amountInput.fill("38");
  delayRecoveryFailure = true;
  const failedRecoveryRange = page.waitForResponse((response): boolean => {
    const url = new URL(response.url());
    return url.pathname === "/api/budget-grid"
      && response.request().method() === "GET"
      && url.searchParams.get("monthFrom") === month
      && url.searchParams.get("monthTo") === month;
  });
  const failedRecoveryPatch = page.waitForResponse((response): boolean =>
    response.url().includes(`/api/budget-adjustments/${adjustmentId}`)
      && response.request().method() === "PATCH"
      && response.status() === 500);
  await recoveryButton.click();
  await recoveryFailureStarted.promise;
  await baseInput.click();
  await expect(baseInput).toBeFocused();
  recoveryFailureGate.resolve();
  expect((await failedRecoveryRange).ok()).toBe(true);
  expect((await failedRecoveryPatch).ok()).toBe(false);
  await expect(recoveryButton).toBeVisible();
  await expect(recoveryButton).toBeEnabled();
  await expect(baseInput).toBeFocused();

  allowPatch = true;
  const recoveredRange = page.waitForResponse((response): boolean => {
    const url = new URL(response.url());
    return url.pathname === "/api/budget-grid"
      && response.request().method() === "GET"
      && url.searchParams.get("monthFrom") === month
      && url.searchParams.get("monthTo") === month;
  });
  const recoveredPatch = page.waitForResponse((response): boolean =>
    response.url().includes(`/api/budget-adjustments/${adjustmentId}`)
      && response.request().method() === "PATCH"
      && response.ok());
  await recoveryButton.click();
  expect((await recoveredRange).ok()).toBe(true);
  expect((await recoveredPatch).ok()).toBe(true);
  await expect(recoveryButton).toHaveCount(0);
  await expect(amountInput).toHaveValue("38");
  await expect(amountInput).toBeFocused();

  await page.getByTestId(`budget-plan-open-${destinationEditorId}`).click();
  await expect(sourcePopover).toHaveCount(0);
  await expect(destinationPopover).toBeVisible();
  expect(baseRequestCount).toBe(0);
});

test("keeps invalid Base visible until a retried mode transition settles once", async ({ page, baseURL }) => {
  if (baseURL === undefined) throw new Error("Local Demo Playwright baseURL is required");
  await setDemoCookies(page, baseURL, "en");
  await gotoBudgetAndWaitForGrid(page);

  const editorId = await getEditorId(page, "spend", "Groceries", 0);
  const popover = page.getByTestId(`budget-plan-popover-${editorId}`);
  const baseInput = page.getByTestId(`budget-plan-base-input-${editorId}`);
  const baseError = page.getByTestId(`budget-plan-base-error-${editorId}`);
  const filteredMode = page.getByTestId("mode-filtered");
  const demoMode = page.getByTestId("mode-demo");
  const modeReload = await captureModeReload(page);

  await page.getByTestId(`budget-plan-open-${editorId}`).click();
  const originalBase = Number(await baseInput.inputValue());
  await baseInput.fill("invalid");
  await filteredMode.click();

  await expect(popover).toBeVisible();
  await expect(baseInput).toBeFocused();
  await expect(baseInput).toHaveAttribute("aria-invalid", "true");
  await expect(baseError).toBeVisible();
  await expect(demoMode).toHaveAttribute("aria-pressed", "true");
  await expect(filteredMode).toHaveAttribute("aria-pressed", "false");
  expect(modeReload.getRequestCount()).toBe(0);
  expect((await page.context().cookies(baseURL)).some(
    (cookie): boolean => cookie.name === "demo" && cookie.value === "true",
  )).toBe(true);

  const retryBase = originalBase + 17;
  await baseInput.fill(String(retryBase));
  await modeReload.started;
  await expect(page.getByTestId("mode-transition-complete")).toHaveCount(1);

  expect(modeReload.getRequestCount()).toBe(1);
  expect(await page.evaluate((): string | null => (
    localStorage.getItem("expense-tracker-visibility-mode")
  ))).toBe("filtered");
  expect((await page.context().cookies(baseURL)).some(
    (cookie): boolean => cookie.name === "demo",
  )).toBe(false);
});

test("keeps an invalid drill-down editor visible until the global mode gate settles", async ({ page, baseURL }) => {
  if (baseURL === undefined) throw new Error("Local Demo Playwright baseURL is required");
  await setDemoCookies(page, baseURL, "en");
  await gotoBudgetAndWaitForGrid(page);

  const editorId = await getEditorId(page, "spend", "Groceries", 0);
  const month = editorId.split(":")[1];
  if (month === undefined) throw new Error(`Cannot read month from editor ID "${editorId}"`);
  await page.getByTestId(`budget-actual-${month}:spend:Groceries`).click();

  const amountCell = page.locator('td[data-testid^="transaction-amount-"]').first();
  await expect(amountCell).toBeVisible();
  const amountCellTestId = await amountCell.getAttribute("data-testid");
  if (amountCellTestId === null) {
    throw new Error("Drill-down amount cell is missing its stable test ID");
  }
  const entryId = amountCellTestId.slice("transaction-amount-".length);
  const amountInput = page.getByTestId(`transaction-amount-input-${entryId}`);
  const allMode = page.getByTestId("mode-all");
  const demoMode = page.getByTestId("mode-demo");
  const modeReload = await captureModeReload(page);

  await amountCell.click();
  const originalAmount = await amountInput.inputValue();
  await amountInput.fill("invalid");
  await allMode.focus();
  await page.keyboard.press("Enter");

  await expect(amountInput).toBeVisible();
  await expect(amountInput).toBeFocused();
  await expect(amountInput).toHaveAttribute("aria-invalid", "true");
  await expect(demoMode).toHaveAttribute("aria-pressed", "true");
  await expect(allMode).toHaveAttribute("aria-pressed", "false");
  expect(modeReload.getRequestCount()).toBe(0);

  await amountInput.fill(originalAmount);
  await amountInput.press("Enter");
  await expect(amountInput).toHaveCount(0);
  await allMode.focus();
  await page.keyboard.press("Enter");
  await modeReload.started;
  await expect(page.getByTestId("mode-transition-complete")).toHaveCount(1);

  expect(modeReload.getRequestCount()).toBe(1);
  expect(await page.evaluate((): string | null => (
    localStorage.getItem("expense-tracker-visibility-mode")
  ))).toBe("all");
  expect((await page.context().cookies(baseURL)).some(
    (cookie): boolean => cookie.name === "demo",
  )).toBe(false);
});

test("keeps a moved adjustment anchored through failed mode settlement and retries once", async ({ page, baseURL }) => {
  test.slow();
  if (baseURL === undefined) throw new Error("Local Demo Playwright baseURL is required");
  await setDemoCookies(page, baseURL, "en");
  await gotoBudgetAndWaitForGrid(page);

  const adjustmentId = "demo-adjustment-groceries-seasonal";
  const editorId = await getEditorId(page, "spend", "Groceries", 0);
  const sourcePopover = page.getByTestId(`budget-plan-popover-${editorId}`);
  const row = page.getByTestId(`budget-adjustment-row-${adjustmentId}`);
  const amountInput = page.getByTestId(`budget-adjustment-amount-${adjustmentId}`);
  const categoryInput = page.getByTestId(`budget-adjustment-category-${adjustmentId}`);
  const recoveryButton = page.getByTestId(`budget-adjustment-recovery-${adjustmentId}`);
  const allMode = page.getByTestId("mode-all");
  const demoMode = page.getByTestId("mode-demo");
  const moveCaptured = createDeferred();
  const moveGate = createDeferred();
  let patchAttempt = 0;
  let allowRetry = false;
  await page.route(
    `**/api/budget-adjustments/${adjustmentId}`,
    async (route): Promise<void> => {
      if (route.request().method() !== "PATCH") {
        await route.continue();
        return;
      }
      patchAttempt += 1;
      if (patchAttempt === 1) {
        const response = await route.fetch();
        moveCaptured.resolve();
        await moveGate.promise;
        await route.fulfill({ response });
        return;
      }
      if (allowRetry) {
        await route.continue();
        return;
      }
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Private forced moved-row failure" }),
      });
    },
  );
  const modeReload = await captureModeReload(page);

  await page.getByTestId(`budget-plan-open-${editorId}`).click();
  await categoryInput.selectOption("Dining");
  await moveCaptured.promise;
  await amountInput.fill("37");
  const failedFollowUp = page.waitForResponse((response): boolean => (
    response.url().includes(`/api/budget-adjustments/${adjustmentId}`)
    && response.request().method() === "PATCH"
    && response.status() === 500
  ));
  moveGate.resolve();
  expect((await failedFollowUp).ok()).toBe(false);
  await expect(recoveryButton).toBeVisible();

  await allMode.click();
  await expect(allMode).toBeEnabled();

  await expect(sourcePopover).toBeVisible();
  await expect(row).toBeVisible();
  await expect(categoryInput).toHaveValue("Dining");
  await expect(amountInput).toHaveValue("37");
  await expect(recoveryButton).toBeVisible();
  await expect(sourcePopover).toContainText("The adjustment could not be saved.");
  await expect(sourcePopover).not.toContainText("Private forced moved-row failure");
  await expect(demoMode).toHaveAttribute("aria-pressed", "true");
  expect(modeReload.getRequestCount()).toBe(0);

  allowRetry = true;
  const successfulRecovery = page.waitForResponse((response): boolean => (
    response.url().includes(`/api/budget-adjustments/${adjustmentId}`)
    && response.request().method() === "PATCH"
    && response.ok()
  ));
  await recoveryButton.click();
  expect((await successfulRecovery).ok()).toBe(true);
  await modeReload.started;
  await expect(page.getByTestId("mode-transition-complete")).toHaveCount(1);

  expect(modeReload.getRequestCount()).toBe(1);
  expect(await page.evaluate((): string | null => (
    localStorage.getItem("expense-tracker-visibility-mode")
  ))).toBe("all");
});

test("keeps a stale Base save open until its acknowledgement is safe to reopen", async ({ page, baseURL }) => {
  if (baseURL === undefined) throw new Error("Local Demo Playwright baseURL is required");
  await setDemoCookies(page, baseURL, "en");
  await gotoBudgetAndWaitForGrid(page);

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
  await expect(popover).toHaveAttribute("aria-busy", "true");
  await expect(baseInput).toBeDisabled();
  await expect(page.getByTestId("budget-sync-status")).toHaveCount(1);
  await expect(openButton).not.toHaveText(originalPlanText);

  staleRangeGate.resolve();
  expect((await staleRangeResponse).ok()).toBe(true);
  await expect(openButton).toHaveText(originalPlanText);
  await expect(baseInput).toHaveValue(String(savedBase));

  delayedBase.release();
  await expect(page.getByTestId("budget-sync-status")).toHaveCount(0);
  await expect(popover).toHaveCount(0);
  await openButton.click();
  await expect(baseInput).toHaveValue(String(savedBase));
});

test("reprojects the final Base acknowledgement after a superseded save fails", async ({ page, baseURL }) => {
  if (baseURL === undefined) throw new Error("Local Demo Playwright baseURL is required");
  await setDemoCookies(page, baseURL, "en");
  await gotoBudgetAndWaitForGrid(page);

  const editorId = await getEditorId(page, "spend", "Groceries", 0);
  const openButton = page.getByTestId(`budget-plan-open-${editorId}`);
  const popover = page.getByTestId(`budget-plan-popover-${editorId}`);
  const baseInput = page.getByTestId(`budget-plan-base-input-${editorId}`);
  const failedSaveStarted = createDeferred();
  const failedSaveGate = createDeferred();
  const requestedValues: Array<number> = [];
  await page.route("**/api/budget-plan", async (route): Promise<void> => {
    const request = route.request();
    if (
      request.method() !== "POST"
      || new URL(request.url()).pathname !== "/api/budget-plan"
    ) {
      await route.continue();
      return;
    }

    requestedValues.push(readBudgetBasePlannedValue(request.postDataJSON()));
    failedSaveStarted.resolve();
    await failedSaveGate.promise;
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "Forced superseded Base failure" }),
    });
  });

  await openButton.click();
  const originalBase = Number(await baseInput.inputValue());
  const originalPlanText = await openButton.textContent();
  if (originalPlanText === null) {
    throw new Error(`Cannot read plan button ${editorId}`);
  }
  const supersededBase = originalBase + 83;
  await baseInput.fill(String(supersededBase));
  await failedSaveStarted.promise;
  await baseInput.fill(String(originalBase));
  await baseInput.press("Enter");
  await expect(popover).toHaveAttribute("aria-busy", "true");

  const failedSave = page.waitForResponse((response): boolean => (
    response.url().endsWith("/api/budget-plan")
    && response.request().method() === "POST"
    && response.status() === 500
  ));
  failedSaveGate.resolve();
  expect((await failedSave).ok()).toBe(false);
  await expect(popover).toHaveCount(0);
  await expect(openButton).toHaveText(originalPlanText);
  expect(requestedValues).toEqual([supersededBase]);

  await openButton.click();
  await expect(baseInput).toHaveValue(String(originalBase));
  await page.keyboard.press("Escape");
});

test("Escape finishes the active Base save without persisting a newer draft", async ({ page, baseURL }) => {
  if (baseURL === undefined) throw new Error("Local Demo Playwright baseURL is required");
  await setDemoCookies(page, baseURL, "en");
  await gotoBudgetAndWaitForGrid(page);

  const editorId = await getEditorId(page, "spend", "Groceries", 0);
  const openButton = page.getByTestId(`budget-plan-open-${editorId}`);
  const popover = page.getByTestId(`budget-plan-popover-${editorId}`);
  const baseInput = page.getByTestId(`budget-plan-base-input-${editorId}`);
  const activeSaveStarted = createDeferred();
  const activeSaveGate = createDeferred();
  const requestedValues: Array<number> = [];
  await page.route("**/api/budget-plan", async (route): Promise<void> => {
    const request = route.request();
    if (
      request.method() !== "POST"
      || new URL(request.url()).pathname !== "/api/budget-plan"
    ) {
      await route.continue();
      return;
    }

    requestedValues.push(readBudgetBasePlannedValue(request.postDataJSON()));
    if (requestedValues.length === 1) {
      const response = await route.fetch();
      activeSaveStarted.resolve();
      await activeSaveGate.promise;
      await route.fulfill({ response });
      return;
    }
    await route.continue();
  });

  await openButton.click();
  const originalBase = Number(await baseInput.inputValue());
  const activeBase = originalBase + 91;
  const discardedBase = activeBase + 1;
  await baseInput.fill(String(activeBase));
  await activeSaveStarted.promise;
  await baseInput.fill(String(discardedBase));
  await page.keyboard.press("Escape");
  await expect(popover).toHaveAttribute("aria-busy", "true");
  await expect(baseInput).toBeDisabled();
  expect(requestedValues).toEqual([activeBase]);

  activeSaveGate.resolve();
  await expect(popover).toHaveCount(0);
  await expect(openButton).toBeFocused();
  await page.waitForTimeout(700);
  expect(requestedValues).toEqual([activeBase]);

  await openButton.click();
  await expect(baseInput).toHaveValue(String(activeBase));
  await page.keyboard.press("Escape");
});

test("serializes superseding Base saves and rolls a definitive failure back for retry", async ({ page, baseURL }) => {
  if (baseURL === undefined) throw new Error("Local Demo Playwright baseURL is required");
  await setDemoCookies(page, baseURL, "en");
  await gotoBudgetAndWaitForGrid(page);

  const editorId = await getEditorId(page, "spend", "Groceries", 0);
  const openButton = page.getByTestId(`budget-plan-open-${editorId}`);
  const popover = page.getByTestId(`budget-plan-popover-${editorId}`);
  const baseInput = page.getByTestId(`budget-plan-base-input-${editorId}`);
  const firstSaveStarted = createDeferred();
  const firstSaveGate = createDeferred();
  const requestedValues: Array<number> = [];
  let saveCount = 0;
  await page.route("**/api/budget-plan", async (route): Promise<void> => {
    const request = route.request();
    if (
      request.method() !== "POST"
      || new URL(request.url()).pathname !== "/api/budget-plan"
    ) {
      await route.continue();
      return;
    }

    requestedValues.push(readBudgetBasePlannedValue(request.postDataJSON()));
    saveCount += 1;
    if (saveCount === 1) {
      const response = await route.fetch();
      firstSaveStarted.resolve();
      await firstSaveGate.promise;
      await route.fulfill({ response });
      return;
    }
    if (saveCount === 2) {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Forced latest Base failure" }),
      });
      return;
    }
    await route.continue();
  });

  await openButton.click();
  const originalBase = Number(await baseInput.inputValue());
  const firstValue = originalBase + 101;
  const failedValue = firstValue + 1;
  const retryValue = failedValue + 1;
  await baseInput.fill(String(firstValue));
  await firstSaveStarted.promise;
  await baseInput.fill(String(failedValue));
  await baseInput.press("Enter");
  await expect(popover).toHaveAttribute("aria-busy", "true");
  await expect(baseInput).toBeDisabled();
  expect(requestedValues).toEqual([firstValue]);

  const failedSave = page.waitForResponse((response): boolean => (
    response.url().endsWith("/api/budget-plan")
    && response.request().method() === "POST"
    && response.status() === 500
  ));
  firstSaveGate.resolve();
  expect((await failedSave).ok()).toBe(false);
  await expect(popover).toBeVisible();
  await expect(popover).toHaveAttribute("aria-busy", "false");
  await expect(baseInput).toHaveValue(String(firstValue));
  await expect(baseInput).toBeFocused();
  await expect(page.getByTestId(`budget-plan-base-error-${editorId}`)).toHaveText(
    "The Base amount could not be saved. Try again.",
  );
  expect(requestedValues).toEqual([firstValue, failedValue]);
  expect(await baseInput.evaluate((element): Readonly<{
    start: number | null;
    end: number | null;
  }> => {
    if (!(element instanceof HTMLInputElement)) {
      throw new Error("Budget Base control must be an input");
    }
    return {
      start: element.selectionStart,
      end: element.selectionEnd,
    };
  })).toEqual({
    start: 0,
    end: String(firstValue).length,
  });

  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  await expect(openButton).toBeFocused();
  await openButton.click();
  await expect(baseInput).toHaveValue(String(firstValue));

  const retrySave = page.waitForResponse((response): boolean => (
    response.url().endsWith("/api/budget-plan")
    && response.request().method() === "POST"
    && response.ok()
  ));
  await baseInput.fill(String(retryValue));
  await baseInput.press("Enter");
  expect((await retrySave).ok()).toBe(true);
  await expect(popover).toHaveCount(0);
  await openButton.click();
  await expect(baseInput).toHaveValue(String(retryValue));
});

test("publishes successful Fill targets through captured range generations", async ({ page, baseURL }) => {
  if (baseURL === undefined) throw new Error("Local Demo Playwright baseURL is required");
  await setDemoCookies(page, baseURL, "en");
  await gotoBudgetAndWaitForGrid(page);

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
  const targetPopover = page.getByTestId(
    `budget-plan-popover-${targetEditorId}`,
  );
  await expect(targetPopover).toHaveAttribute("aria-busy", "true");
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

  const beforeStaleRangeClass = await targetPlanCell.getAttribute("class");
  if (beforeStaleRangeClass === null) {
    throw new Error(`Cannot read target cell ${targetEditorId}`);
  }
  await page.getByTestId(`budget-plan-open-${sourceEditorId}`).click();
  const sourcePopover = page.getByTestId(
    `budget-plan-popover-${sourceEditorId}`,
  );
  await expect(targetPopover).toHaveAttribute("aria-busy", "true");
  await expect(sourcePopover).toHaveCount(0);
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

  delayedBase.release();
  await expect(targetPopover).toHaveCount(0);
  await expect(sourcePopover).toBeVisible();
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
  await expect(page.getByTestId("budget-sync-status")).toHaveCount(0);

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
  await gotoBudgetAndWaitForGrid(page);
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
