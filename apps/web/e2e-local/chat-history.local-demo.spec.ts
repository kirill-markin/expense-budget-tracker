import {
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
  type Route,
} from "@playwright/test";

type CatalogStatus = "idle" | "running" | "interrupted";

type CatalogSession = Readonly<{
  sessionId: string;
  title: string;
  lastMessageAt: string;
  status: CatalogStatus;
  mainContentInvalidationVersion: number;
}>;

type InvalidationMessage = Readonly<{
  type: "main_content_invalidation";
  workspaceId: string;
  version: number;
  sourceId: string;
  emittedAt: number;
}>;

type InvalidationTestWindow = Window & {
  __chatHistoryInvalidations?: Array<InvalidationMessage>;
};

type VisibilityTestWindow = Window & {
  __setChatHistoryVisibility?: (visibility: DocumentVisibilityState) => void;
};

type Deferred = Readonly<{
  promise: Promise<void>;
  resolve: () => void;
}>;

type ElementBounds = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

const RUNNING_TURN_ID = "00000000-0000-4000-8000-000000000001";
const INVALIDATION_STORAGE_KEY =
  "expense-tracker-main-content-invalidation";

const createDeferred = (): Deferred => {
  let resolvePromise: (() => void) | null = null;
  const promise = new Promise<void>((resolve): void => {
    resolvePromise = resolve;
  });
  if (resolvePromise === null) {
    throw new Error("Failed to create deferred browser-test operation");
  }

  return {
    promise,
    resolve: resolvePromise,
  };
};

const getElementBounds = async (locator: Locator): Promise<ElementBounds> => {
  const bounds = await locator.boundingBox();
  if (bounds === null) {
    throw new Error("Cannot inspect chat history geometry: element is not visible");
  }
  return bounds;
};

const setWorkspaceCookies = async (
  context: BrowserContext,
  baseURL: string,
  locale: string,
): Promise<void> => {
  const origin = new URL(baseURL);
  await context.addCookies([
    {
      name: "locale",
      value: locale,
      domain: origin.hostname,
      path: "/",
      sameSite: "Lax",
    },
  ]);
};

const mockWorkspaceDependencies = async (page: Page): Promise<void> => {
  await page.route("**/api/categories", async (route): Promise<void> => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ categories: [] }),
    });
  });
  await page.route(
    "**/api/workspace-settings",
    async (route): Promise<void> => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ filteredCategories: null }),
      });
    },
  );
};

const installVisibilityControl = async (
  page: Page,
  initialVisibility: DocumentVisibilityState,
): Promise<void> => {
  await page.addInitScript((visibilityAtStartup: DocumentVisibilityState): void => {
    let visibility = visibilityAtStartup;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: (): DocumentVisibilityState => visibility,
    });
    (window as VisibilityTestWindow).__setChatHistoryVisibility = (
      nextVisibility: DocumentVisibilityState,
    ): void => {
      visibility = nextVisibility;
      document.dispatchEvent(new Event("visibilitychange"));
    };
  }, initialVisibility);
};

const setTestVisibility = async (
  page: Page,
  visibility: DocumentVisibilityState,
): Promise<void> => {
  await page.evaluate((nextVisibility: DocumentVisibilityState): void => {
    const setVisibility =
      (window as VisibilityTestWindow).__setChatHistoryVisibility;
    if (setVisibility === undefined) {
      throw new Error("Chat history visibility test control is unavailable");
    }
    setVisibility(nextVisibility);
  }, visibility);
};

const fulfillCatalogPage = async (
  route: Route,
  sessions: ReadonlyArray<CatalogSession>,
  nextCursor: string | null,
): Promise<void> => {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      sessions,
      nextCursor,
    }),
  });
};

const fulfillCatalog = async (
  route: Route,
  sessions: ReadonlyArray<CatalogSession>,
): Promise<void> => {
  await fulfillCatalogPage(route, sessions, null);
};

const fulfillSnapshot = async (
  route: Route,
  sessionId: string,
  runState: CatalogStatus,
): Promise<void> => {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      sessionId,
      runState,
      activeTurnId: runState === "running" ? RUNNING_TURN_ID : null,
      updatedAt: Date.now(),
      mainContentInvalidationVersion: 0,
      messages: [],
    }),
  });
};

test("activates accessible history, local New, and fullscreen navigation without stopping another run", async ({
  page,
  context,
  baseURL,
}) => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }

  const runningSessionId = "session-history-running";
  const recentSessionId = "session-history-recent";
  const oldActivity = new Date(
    Date.now() - (8 * 60 * 60 * 1000),
  ).toISOString();
  const sessions: ReadonlyArray<CatalogSession> = [
    {
      sessionId: runningSessionId,
      title: "Running session with a deliberately long one-line title",
      lastMessageAt: oldActivity,
      status: "running",
      mainContentInvalidationVersion: 0,
    },
    {
      sessionId: recentSessionId,
      title: "Recent historical session",
      lastMessageAt: oldActivity,
      status: "idle",
      mainContentInvalidationVersion: 0,
    },
  ];
  let catalogRequestCount = 0;
  let createRequestCount = 0;
  let stopRequestCount = 0;

  await mockWorkspaceDependencies(page);
  page.on("request", (request): void => {
    const requestUrl = new URL(request.url());
    if (request.method() === "POST" && requestUrl.pathname === "/api/chat") {
      createRequestCount += 1;
    }
    if (
      request.method() === "POST"
      && requestUrl.pathname === "/api/chat/stop"
    ) {
      stopRequestCount += 1;
    }
  });
  await page.route(/\/api\/chat\/sessions\?/u, async (route): Promise<void> => {
    catalogRequestCount += 1;
    if (catalogRequestCount === 2) {
      await route.fulfill({
        status: 503,
        contentType: "text/plain",
        body: "Temporary catalog failure",
      });
      return;
    }
    await fulfillCatalog(route, sessions);
  });
  await page.route(
    /\/api\/chat\?sessionId=/u,
    async (route): Promise<void> => {
      const sessionId = new URL(route.request().url()).searchParams.get(
        "sessionId",
      );
      if (sessionId !== runningSessionId && sessionId !== recentSessionId) {
        throw new Error(
          `Unexpected chat history snapshot sessionId: ${String(sessionId)}`,
        );
      }
      await fulfillSnapshot(
        route,
        sessionId,
        sessionId === runningSessionId ? "running" : "idle",
      );
    },
  );

  await setWorkspaceCookies(context, baseURL, "en");
  await page.goto(`/chat?session=${runningSessionId}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByTestId("chat-composer-input")).toBeEditable();

  const historyButton = page.getByTestId("chat-history-open");
  await expect(historyButton).toHaveAccessibleName(/1 running/u);
  await expect(page.getByTestId("chat-history-running-count")).toHaveText("1");
  await historyButton.click();

  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByTestId("chat-history-error")).toBeVisible();
  await expect(page.getByTestId("chat-history-running")).toBeVisible();
  await expect(page.getByTestId("chat-history-recent")).toBeVisible();
  const runningRow = page.getByTestId(
    `chat-history-session-${runningSessionId}`,
  );
  const recentRow = page.getByTestId(
    `chat-history-session-${recentSessionId}`,
  );
  await expect(runningRow).toHaveAttribute("aria-current", "true");
  await expect(recentRow).toBeVisible();
  expect(await runningRow.evaluate(
    (element): string => getComputedStyle(element).whiteSpace,
  )).toBe("nowrap");

  await recentRow.click();
  await expect(page.getByTestId("chat-history-dialog")).not.toBeVisible();
  await expect(page).toHaveURL(
    (url) => url.pathname === "/chat"
      && url.searchParams.get("session") === recentSessionId,
  );
  expect(stopRequestCount).toBe(0);

  await historyButton.click();
  await page.getByTestId("chat-history-new").click();
  await expect(page).toHaveURL(
    (url) => url.pathname === "/chat"
      && !url.searchParams.has("session"),
  );
  await expect(page.getByTestId("chat-composer-input")).toBeEditable();
  expect(createRequestCount).toBe(0);

  await page.goBack();
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("session") === recentSessionId,
  );
  await page.goBack();
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("session") === runningSessionId,
  );
  await page.goForward();
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("session") === recentSessionId,
  );
  expect(stopRequestCount).toBe(0);
});

test("uses an anchored non-modal desktop popover and a fullscreen mobile surface", async ({
  page,
  context,
  baseURL,
}) => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }

  await page.setViewportSize({ width: 1280, height: 800 });
  await mockWorkspaceDependencies(page);
  await page.route(/\/api\/chat\/sessions\?/u, async (route): Promise<void> => {
    await fulfillCatalog(route, []);
  });
  const pageErrors: Array<string> = [];
  page.on("pageerror", (error): void => {
    pageErrors.push(error.message);
  });
  await setWorkspaceCookies(context, baseURL, "en");
  const origin = new URL(baseURL);
  await context.addCookies([
    {
      name: "demo",
      value: "true",
      domain: origin.hostname,
      path: "/",
      sameSite: "Lax",
    },
    {
      name: "chat-open",
      value: "true",
      domain: origin.hostname,
      path: "/",
      sameSite: "Lax",
    },
  ]);

  await page.goto("/", { waitUntil: "domcontentloaded" });
  const historyButton = page.getByTestId("chat-history-open");
  const copyButton = page.getByRole("button", { name: "Copy chat" });
  const newButton = page.getByTestId("chat-new");
  const sidebarCloseButton = page.getByTestId("chat-sidebar-close");
  const dialog = page.getByTestId("chat-history-dialog");
  const controlHeights = await Promise.all([
    historyButton,
    copyButton,
    newButton,
    sidebarCloseButton,
  ].map(async (control): Promise<number> =>
    (await getElementBounds(control)).height));
  expect(new Set(controlHeights).size).toBe(1);

  const chatPanel = page.getByTestId("chat-panel");
  const initialPanelBounds = await getElementBounds(chatPanel);
  const resizeHandleX =
    initialPanelBounds.x + initialPanelBounds.width - 2;
  const resizeHandleY = initialPanelBounds.y + (initialPanelBounds.height / 2);
  await page.mouse.move(resizeHandleX, resizeHandleY);
  await page.mouse.down();
  await historyButton.press("Enter");
  await expect(dialog).toBeVisible();
  await page.mouse.move(resizeHandleX + 260, resizeHandleY, { steps: 5 });
  await expect.poll(async (): Promise<number> =>
    (await getElementBounds(chatPanel)).width,
  ).toBeGreaterThan(initialPanelBounds.width + 200);
  await expect.poll(async (): Promise<number> => {
    const buttonBounds = await getElementBounds(historyButton);
    const dialogBounds = await getElementBounds(dialog);
    return Math.abs(
      (dialogBounds.x + dialogBounds.width)
      - (buttonBounds.x + buttonBounds.width),
    );
  }).toBeLessThanOrEqual(1);
  await page.mouse.up();
  await page.getByTestId("chat-history-close").click();

  await page.getByRole("navigation").locator('a[href="/chat"]').click();
  await expect(page).toHaveURL((url) => url.pathname === "/chat");
  await expect(page.getByTestId("chat-composer-input")).toBeEditable();
  await historyButton.click();
  await expect(dialog).toBeVisible();
  await expect(historyButton).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("chat-history-new")).toBeFocused();

  await page.goBack();
  await expect(page).toHaveURL((url) => url.pathname === "/");
  await expect(dialog).toBeVisible();
  await expect(historyButton).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("chat-history-new")).toBeFocused();

  await page.goForward();
  await expect(page).toHaveURL((url) => url.pathname === "/chat");
  await expect(dialog).toBeVisible();
  await expect(historyButton).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("chat-history-new")).toBeFocused();
  expect(pageErrors).toEqual([]);

  const desktopButtonBounds = await getElementBounds(historyButton);
  const desktopDialogBounds = await getElementBounds(dialog);
  expect(desktopDialogBounds.y).toBeCloseTo(
    desktopButtonBounds.y + desktopButtonBounds.height + 6,
    0,
  );
  expect(desktopDialogBounds.x + desktopDialogBounds.width).toBeCloseTo(
    desktopButtonBounds.x + desktopButtonBounds.width,
    0,
  );
  expect(await dialog.evaluate(
    (element): boolean => element.matches(":modal"),
  )).toBe(false);
  expect(await dialog.evaluate(
    (element): string => getComputedStyle(element).backgroundColor,
  )).toBe("rgb(255, 255, 255)");
  expect(await page.locator("[inert]").count()).toBe(0);

  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(historyButton).toBeFocused();
  await historyButton.click();
  await page.getByTestId("chat-history-close").click();
  await expect(dialog).not.toBeVisible();
  await expect(historyButton).toBeFocused();

  const composer = page.getByTestId("chat-composer-input");
  await composer.fill("outside pointer action must still run");
  await historyButton.click();
  await newButton.click();
  await expect(dialog).not.toBeVisible();
  await expect(composer).toHaveValue("");
  await expect(composer).toBeFocused();

  await page.setViewportSize({ width: 500, height: 700 });
  await historyButton.click();
  const clampedDialogBounds = await getElementBounds(dialog);
  expect(clampedDialogBounds.x).toBeGreaterThanOrEqual(8);
  expect(
    clampedDialogBounds.x + clampedDialogBounds.width,
  ).toBeLessThanOrEqual(492);

  await page.setViewportSize({ width: 390, height: 720 });
  await expect.poll(async (): Promise<Readonly<{
    width: number;
    height: number;
  }>> => {
    const bounds = await getElementBounds(dialog);
    return { width: bounds.width, height: bounds.height };
  }).toEqual({ width: 390, height: 720 });
  const mobileDialogBounds = await getElementBounds(dialog);
  expect(mobileDialogBounds.x).toBeCloseTo(0, 0);
  expect(mobileDialogBounds.y).toBeCloseTo(0, 0);
  expect(mobileDialogBounds.width).toBeCloseTo(390, 0);
  expect(mobileDialogBounds.height).toBeCloseTo(720, 0);
  await page.getByTestId("chat-history-close").click();

  await page.setViewportSize({ width: 1280, height: 800 });
  await setWorkspaceCookies(context, baseURL, "ar");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await historyButton.click();
  const rtlButtonBounds = await getElementBounds(historyButton);
  const rtlDialogBounds = await getElementBounds(dialog);
  expect(rtlDialogBounds.x).toBeCloseTo(rtlButtonBounds.x, 0);
  expect(rtlDialogBounds.x).toBeGreaterThanOrEqual(8);
  expect(rtlDialogBounds.x + rtlDialogBounds.width).toBeLessThanOrEqual(1272);
});

test("keeps intentional outside focus and repairs focus when an owned control is removed", async ({
  page,
  context,
  baseURL,
}) => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }

  const firstCursor = "focus-page-1";
  const secondCursor = "focus-page-2";
  const firstPageRequestReceived = createDeferred();
  const releaseFirstPage = createDeferred();
  const secondPageRequestReceived = createDeferred();
  const releaseSecondPage = createDeferred();
  const oldActivity = new Date(
    Date.now() - (8 * 60 * 60 * 1000),
  ).toISOString();
  const createSession = (
    sessionId: string,
    title: string,
  ): CatalogSession => ({
    sessionId,
    title,
    lastMessageAt: oldActivity,
    status: "idle",
    mainContentInvalidationVersion: 0,
  });

  await mockWorkspaceDependencies(page);
  await page.route(/\/api\/chat\/sessions\?/u, async (route): Promise<void> => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    if (cursor === null) {
      await fulfillCatalogPage(
        route,
        [createSession("session-focus-page-1", "Focus page one")],
        firstCursor,
      );
      return;
    }
    if (cursor === firstCursor) {
      firstPageRequestReceived.resolve();
      await releaseFirstPage.promise;
      await fulfillCatalogPage(
        route,
        [createSession("session-focus-page-2", "Focus page two")],
        secondCursor,
      );
      return;
    }
    if (cursor === secondCursor) {
      secondPageRequestReceived.resolve();
      await releaseSecondPage.promise;
      await fulfillCatalogPage(
        route,
        [createSession("session-focus-page-3", "Focus page three")],
        null,
      );
      return;
    }
    throw new Error(`Unexpected focus pagination cursor: ${cursor}`);
  });

  await setWorkspaceCookies(context, baseURL, "en");
  await page.goto("/chat", { waitUntil: "domcontentloaded" });
  const composer = page.getByTestId("chat-composer-input");
  await expect(composer).toBeEditable();
  await composer.fill("keep focus outside history");
  await page.getByTestId("chat-history-open").click();

  const dialog = page.getByTestId("chat-history-dialog");
  const loadMore = page.getByTestId("chat-history-load-more");
  await expect(loadMore).toBeVisible();
  await loadMore.click();
  await firstPageRequestReceived.promise;
  await expect(loadMore).toBeFocused();
  await page.keyboard.press("Tab");
  await expect.poll(async (): Promise<boolean> => page.evaluate((): boolean => {
    const historyDialog = document.querySelector(
      '[data-testid="chat-history-dialog"]',
    );
    return historyDialog !== null
      && document.activeElement !== null
      && !historyDialog.contains(document.activeElement);
  })).toBe(true);

  const submitButton = page.getByTestId("chat-submit");
  await submitButton.focus();
  await expect(submitButton).toBeFocused();
  releaseFirstPage.resolve();
  await expect(
    page.getByTestId("chat-history-session-session-focus-page-2"),
  ).toBeVisible();
  await expect(loadMore).toBeVisible();
  await expect(submitButton).toBeFocused();

  await loadMore.click();
  await secondPageRequestReceived.promise;
  await expect(loadMore).toBeFocused();
  releaseSecondPage.resolve();
  await expect(
    page.getByTestId("chat-history-session-session-focus-page-3"),
  ).toBeVisible();
  await expect(loadMore).toHaveCount(0);
  await expect(page.getByTestId("chat-history-new")).toBeFocused();
  await expect(dialog).toBeVisible();
});

test("a successful catalog retry restores an eligible automatic session after bootstrap failure", async ({
  page,
  context,
  baseURL,
}) => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }

  const recoveredSessionId = "session-catalog-recovered";
  const currentActivity = new Date().toISOString();
  let catalogRequestCount = 0;
  let snapshotRequestCount = 0;
  let createRequestCount = 0;

  await mockWorkspaceDependencies(page);
  page.on("request", (request): void => {
    const requestUrl = new URL(request.url());
    if (request.method() === "POST" && requestUrl.pathname === "/api/chat") {
      createRequestCount += 1;
    }
  });
  await page.route(/\/api\/chat\/sessions\?/u, async (route): Promise<void> => {
    catalogRequestCount += 1;
    if (catalogRequestCount === 1) {
      await route.fulfill({
        status: 503,
        contentType: "text/plain",
        body: "Catalog unavailable during bootstrap",
      });
      return;
    }
    await fulfillCatalog(route, [{
      sessionId: recoveredSessionId,
      title: "Recovered session",
      lastMessageAt: currentActivity,
      status: "idle",
      mainContentInvalidationVersion: 0,
    }]);
  });
  await page.route(
    /\/api\/chat\?sessionId=/u,
    async (route): Promise<void> => {
      const sessionId = new URL(route.request().url()).searchParams.get(
        "sessionId",
      );
      if (sessionId !== recoveredSessionId) {
        throw new Error(
          `Unexpected recovered snapshot sessionId: ${String(sessionId)}`,
        );
      }
      snapshotRequestCount += 1;
      await fulfillSnapshot(route, sessionId, "idle");
    },
  );

  await setWorkspaceCookies(context, baseURL, "en");
  await page.goto("/chat", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("chat-composer-input")).toBeEditable();
  await expect(page.getByTestId("chat-history-error")).toContainText(
    "Chat session catalog request failed: status=503",
  );
  expect(catalogRequestCount).toBe(1);
  expect(snapshotRequestCount).toBe(0);

  await page.getByTestId("chat-history-open").click();
  await expect.poll((): number => catalogRequestCount).toBe(2);
  await expect.poll((): number => snapshotRequestCount).toBe(1);
  await expect(page.getByTestId("chat-history-error")).toHaveCount(0);
  await expect(page).toHaveURL(
    (url) => url.pathname === "/chat"
      && url.searchParams.get("session") === recoveredSessionId,
  );
  await expect(
    page.getByTestId(`chat-history-session-${recoveredSessionId}`),
  ).toHaveAttribute("aria-current", "true");
  expect(createRequestCount).toBe(0);
  await page.getByTestId("chat-history-close").click();
});

test("an explicit New selection fences an in-flight catalog recovery", async ({
  page,
  context,
  baseURL,
}) => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }

  const recoveredSessionId = "session-catalog-fenced";
  const recoveryRequestReceived = createDeferred();
  const releaseRecovery = createDeferred();
  let catalogRequestCount = 0;
  let snapshotRequestCount = 0;

  await mockWorkspaceDependencies(page);
  await page.route(/\/api\/chat\/sessions\?/u, async (route): Promise<void> => {
    catalogRequestCount += 1;
    if (catalogRequestCount === 1) {
      await route.fulfill({
        status: 503,
        contentType: "text/plain",
        body: "Catalog unavailable during bootstrap",
      });
      return;
    }
    if (catalogRequestCount === 2) {
      recoveryRequestReceived.resolve();
      await releaseRecovery.promise;
    }
    await fulfillCatalog(route, [{
      sessionId: recoveredSessionId,
      title: "Fenced recovered session",
      lastMessageAt: new Date().toISOString(),
      status: "idle",
      mainContentInvalidationVersion: 0,
    }]);
  });
  await page.route(
    /\/api\/chat\?sessionId=/u,
    async (route): Promise<void> => {
      snapshotRequestCount += 1;
      await fulfillSnapshot(route, recoveredSessionId, "idle");
    },
  );

  await setWorkspaceCookies(context, baseURL, "en");
  await page.goto("/chat", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("chat-composer-input")).toBeEditable();

  await page.getByTestId("chat-history-open").click();
  await recoveryRequestReceived.promise;
  await page.getByTestId("chat-history-new").click();
  await expect(page.getByTestId("chat-history-dialog")).not.toBeVisible();

  releaseRecovery.resolve();
  await expect.poll((): number => catalogRequestCount).toBe(2);
  await page.getByTestId("chat-history-open").click();
  await expect(
    page.getByTestId(`chat-history-session-${recoveredSessionId}`),
  ).toBeVisible();
  await expect(page).toHaveURL(
    (url) => url.pathname === "/chat"
      && url.searchParams.get("session") === null,
  );
  expect(snapshotRequestCount).toBe(0);
  await page.getByTestId("chat-history-close").click();
});

test("polls a closed catalog only while background sessions run and invalidates once per version", async ({
  page,
  context,
  baseURL,
}) => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }

  const backgroundSessionA = "session-background-a";
  const backgroundSessionC = "session-background-c";
  const selectedSessionB = "session-selected-b";
  const currentActivity = new Date().toISOString();
  let catalogRequestCount = 0;
  const snapshotRequestCounts = new Map<string, number>();

  await page.clock.install({ time: new Date() });
  await installVisibilityControl(page, "hidden");
  await page.addInitScript((storageKey: string): void => {
    const originalSetItem = Storage.prototype.setItem;
    Object.defineProperty(Storage.prototype, "setItem", {
      configurable: true,
      writable: true,
      value: function (
        this: Storage,
        key: string,
        value: string,
      ): void {
        if (this === window.localStorage && key === storageKey) {
          const parsed = JSON.parse(value) as InvalidationMessage;
          const testWindow = window as InvalidationTestWindow;
          const invalidations = testWindow.__chatHistoryInvalidations ?? [];
          invalidations.push(parsed);
          testWindow.__chatHistoryInvalidations = invalidations;
        }
        originalSetItem.call(this, key, value);
      },
    });
  }, INVALIDATION_STORAGE_KEY);
  await mockWorkspaceDependencies(page);
  await page.route(/\/api\/chat\/sessions\?/u, async (route): Promise<void> => {
    catalogRequestCount += 1;
    const terminal = catalogRequestCount >= 3;
    const invalidationVersion = catalogRequestCount >= 2 ? 1 : 0;
    await fulfillCatalog(route, [
      {
        sessionId: backgroundSessionA,
        title: "Background A",
        lastMessageAt: currentActivity,
        status: terminal ? "idle" : "running",
        mainContentInvalidationVersion: invalidationVersion,
      },
      {
        sessionId: backgroundSessionC,
        title: "Background C",
        lastMessageAt: currentActivity,
        status: terminal ? "idle" : "running",
        mainContentInvalidationVersion: 0,
      },
      {
        sessionId: selectedSessionB,
        title: "Selected B",
        lastMessageAt: currentActivity,
        status: "idle",
        mainContentInvalidationVersion: 0,
      },
    ]);
  });
  await page.route(
    /\/api\/chat\?sessionId=/u,
    async (route): Promise<void> => {
      const sessionId = new URL(route.request().url()).searchParams.get(
        "sessionId",
      );
      if (sessionId === null) {
        throw new Error("Chat history snapshot request is missing sessionId");
      }
      snapshotRequestCounts.set(
        sessionId,
        (snapshotRequestCounts.get(sessionId) ?? 0) + 1,
      );
      if (sessionId !== selectedSessionB) {
        throw new Error(
          `Background session unexpectedly received snapshot polling: ${sessionId}`,
        );
      }
      await fulfillSnapshot(route, sessionId, "idle");
    },
  );

  await setWorkspaceCookies(context, baseURL, "en");
  await page.goto(`/chat?session=${selectedSessionB}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByTestId("chat-composer-input")).toBeEditable();
  await expect(page.getByTestId("chat-history-running-count")).toHaveText("2");
  expect(catalogRequestCount).toBe(1);
  expect(snapshotRequestCounts.get(selectedSessionB)).toBe(1);

  await page.clock.fastForward(30_000);
  expect(catalogRequestCount).toBe(1);

  await setTestVisibility(page, "visible");
  await expect.poll((): number => catalogRequestCount).toBe(2);
  await expect.poll(async (): Promise<ReadonlyArray<number>> =>
    page.evaluate((): ReadonlyArray<number> =>
      ((window as InvalidationTestWindow).__chatHistoryInvalidations ?? [])
        .map((message): number => message.version),
    )).toEqual([1]);

  await page.clock.fastForward(10_000);
  await expect.poll((): number => catalogRequestCount).toBe(3);
  await expect(page.getByTestId("chat-history-running-count")).toHaveCount(0);
  await page.clock.fastForward(30_000);
  expect(catalogRequestCount).toBe(3);
  expect(snapshotRequestCounts.get(selectedSessionB)).toBe(1);
  expect(snapshotRequestCounts.has(backgroundSessionA)).toBe(false);
  expect(snapshotRequestCounts.has(backgroundSessionC)).toBe(false);
  expect(await page.evaluate((): ReadonlyArray<number> =>
    ((window as InvalidationTestWindow).__chatHistoryInvalidations ?? [])
      .map((message): number => message.version),
  )).toEqual([1]);
});

test("visibility return rolls an old automatic idle session to a draft and keeps RTL badge placement", async ({
  page,
  context,
  baseURL,
}) => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }

  const sessionId = "session-visibility-policy";
  const oldActivity = new Date(
    Date.now() - (8 * 60 * 60 * 1000),
  ).toISOString();
  let catalogRequestCount = 0;
  let createRequestCount = 0;

  await installVisibilityControl(page, "visible");
  await mockWorkspaceDependencies(page);
  page.on("request", (request): void => {
    const requestUrl = new URL(request.url());
    if (request.method() === "POST" && requestUrl.pathname === "/api/chat") {
      createRequestCount += 1;
    }
  });
  await page.route(/\/api\/chat\/sessions\?/u, async (route): Promise<void> => {
    catalogRequestCount += 1;
    await fulfillCatalog(route, [{
      sessionId,
      title: "Visibility policy",
      lastMessageAt: oldActivity,
      status: catalogRequestCount === 1 ? "running" : "idle",
      mainContentInvalidationVersion: 0,
    }]);
  });
  await page.route(
    /\/api\/chat\?sessionId=/u,
    async (route): Promise<void> => {
      await fulfillSnapshot(route, sessionId, "running");
    },
  );

  await setWorkspaceCookies(context, baseURL, "ar");
  await page.goto("/chat", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("chat-composer-input")).toBeEditable();
  await expect(page.getByTestId("chat-history-running-count")).toHaveText("1");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

  const badgePlacement = await page.evaluate((): Readonly<{
    buttonCenter: number;
    badgeCenter: number;
  }> => {
    const button = document.querySelector<HTMLElement>(
      '[data-testid="chat-history-open"]',
    );
    const badge = document.querySelector<HTMLElement>(
      '[data-testid="chat-history-running-count"]',
    );
    if (button === null || badge === null) {
      throw new Error("RTL chat history badge is not mounted");
    }
    const buttonBounds = button.getBoundingClientRect();
    const badgeBounds = badge.getBoundingClientRect();
    return {
      buttonCenter: buttonBounds.left + (buttonBounds.width / 2),
      badgeCenter: badgeBounds.left + (badgeBounds.width / 2),
    };
  });
  expect(badgePlacement.badgeCenter).toBeLessThan(
    badgePlacement.buttonCenter,
  );

  await setTestVisibility(page, "hidden");
  await setTestVisibility(page, "visible");

  await expect.poll((): number => catalogRequestCount).toBe(2);
  await expect(page).toHaveURL(
    (url) => url.pathname === "/chat"
      && !url.searchParams.has("session"),
  );
  await expect(page.getByTestId("chat-history-running-count")).toHaveCount(0);
  await expect(page.getByTestId("chat-composer-input")).toBeEditable();
  expect(createRequestCount).toBe(0);
});

test("surfaces an unauthorized explicit session and resolves to a safe catalog row", async ({
  page,
  context,
  baseURL,
}) => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }

  const unavailableSessionId = "session-unauthorized";
  const safeSessionId = "session-safe";
  const currentActivity = new Date().toISOString();
  let unavailableSnapshotRequestCount = 0;
  let safeSnapshotRequestCount = 0;

  await mockWorkspaceDependencies(page);
  await page.route(/\/api\/chat\/sessions\?/u, async (route): Promise<void> => {
    await fulfillCatalog(route, [{
      sessionId: safeSessionId,
      title: "Safe session",
      lastMessageAt: currentActivity,
      status: "idle",
      mainContentInvalidationVersion: 0,
    }]);
  });
  await page.route(
    /\/api\/chat\?sessionId=/u,
    async (route): Promise<void> => {
      const sessionId = new URL(route.request().url()).searchParams.get(
        "sessionId",
      );
      if (sessionId === unavailableSessionId) {
        unavailableSnapshotRequestCount += 1;
        await route.fulfill({
          status: 403,
          contentType: "text/plain",
          body: "Forbidden",
        });
        return;
      }
      if (sessionId !== safeSessionId) {
        throw new Error(
          `Unexpected unauthorized-recovery snapshot sessionId: ${String(sessionId)}`,
        );
      }
      safeSnapshotRequestCount += 1;
      await fulfillSnapshot(route, safeSessionId, "idle");
    },
  );

  await setWorkspaceCookies(context, baseURL, "en");
  await page.goto(`/chat?session=${unavailableSessionId}`, {
    waitUntil: "domcontentloaded",
  });

  await expect.poll((): number => unavailableSnapshotRequestCount).toBe(1);
  await expect.poll((): number => safeSnapshotRequestCount).toBe(1);
  await expect(page).toHaveURL(
    (url) => url.pathname === "/chat"
      && url.searchParams.get("session") === safeSessionId,
  );
  await expect(page.getByTestId("chat-history-dialog")).toBeVisible();
  await expect(page.getByTestId("chat-history-error")).toHaveText(
    "This chat is unavailable. A safe chat was selected.",
  );
  await expect(
    page.getByTestId(`chat-history-session-${safeSessionId}`),
  ).toHaveAttribute("aria-current", "true");

  await page.getByTestId("chat-history-close").click();
  await expect(page.getByTestId("chat-history-dialog")).not.toBeVisible();
  await expect(page.getByTestId("chat-history-error")).toHaveCount(0);
});
