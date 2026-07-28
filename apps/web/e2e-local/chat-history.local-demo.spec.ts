import {
  expect,
  test,
  type BrowserContext,
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

const fulfillCatalog = async (
  route: Route,
  sessions: ReadonlyArray<CatalogSession>,
): Promise<void> => {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      sessions,
      nextCursor: null,
    }),
  });
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
