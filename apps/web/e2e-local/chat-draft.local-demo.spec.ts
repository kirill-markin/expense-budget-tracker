import { expect, test, type Locator, type Page } from "@playwright/test";

type NavigationHref = "/chat" | "/transactions";
const localNavigationTimeoutMs = 20_000;
const RUNNING_SNAPSHOT_TURN_ID =
  "00000000-0000-4000-8000-000000000001";
const SECOND_RUNNING_SNAPSHOT_TURN_ID =
  "00000000-0000-4000-8000-000000000002";
const NEWER_RUNNING_SNAPSHOT_TURN_ID =
  "00000000-0000-4000-8000-000000000003";
const PERSISTED_SNAPSHOT_MESSAGE_ID =
  "00000000-0000-4000-8000-000000000004";

type DictationTestWindow = Window & Readonly<{
  __resolveChatMicrophonePermission?: () => void;
  __chatMicrophonePermissionRequestCount?: number;
  __chatMicrophoneTrackStopCount?: number;
}>;

type LayoutCleanupTestWindow = Window & Readonly<{
  __releaseChatCreateAtLayoutCommit?: () => Promise<void>;
  __chatCreateReleasedAtLayoutCommit?: boolean;
  __chatAbortAfterCreateReleaseCount?: number;
  __chatPreviousScopeRenderedAfterCommit?: boolean;
  __chatPreviousCatalogRenderedAfterCommit?: boolean;
}>;

type StorageMutationTestWindow = Window & Readonly<{
  __chatStorageMutationFailed?: boolean;
  __chatStorageMutationAttemptCount?: number;
  __restoreChatStorageMutation?: () => void;
}>;

type StopContinuationTestWindow = Window & Readonly<{
  __chatStopResponseTerminalCount?: number;
}>;

type Deferred = Readonly<{
  promise: Promise<void>;
  resolve: () => void;
}>;

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

const failNextSessionStorageMutation = async (
  page: Page,
  method: "setItem" | "removeItem",
  storageKey: string,
): Promise<void> => {
  await page.evaluate(
    ({ mutationMethod, keyToFail }): void => {
      const testWindow = window as StorageMutationTestWindow;
      const storagePrototype = Storage.prototype;
      const originalSetItem = storagePrototype.setItem;
      const originalRemoveItem = storagePrototype.removeItem;
      const originalMethod = mutationMethod === "setItem"
        ? originalSetItem
        : originalRemoveItem;
      let hasFailed = false;
      let matchingAttemptCount = 0;
      const replacement = function (
        this: Storage,
        key: string,
        value?: string,
      ): void {
        if (
          this === window.sessionStorage
          && key === keyToFail
        ) {
          matchingAttemptCount += 1;
          Object.defineProperty(
            testWindow,
            "__chatStorageMutationAttemptCount",
            {
              configurable: true,
              value: matchingAttemptCount,
            },
          );
        }
        if (
          this === window.sessionStorage
          && key === keyToFail
          && !hasFailed
        ) {
          hasFailed = true;
          Object.defineProperty(testWindow, "__chatStorageMutationFailed", {
            configurable: true,
            value: true,
          });
          throw new DOMException(
            `Synthetic chat storage failure for ${key}`,
            "QuotaExceededError",
          );
        }
        if (mutationMethod === "setItem") {
          if (value === undefined) {
            throw new Error("Storage setItem replacement requires a value");
          }
          originalSetItem.call(this, key, value);
          return;
        }
        originalRemoveItem.call(this, key);
      };
      Object.defineProperty(storagePrototype, mutationMethod, {
        configurable: true,
        value: replacement,
        writable: true,
      });
      Object.defineProperty(testWindow, "__restoreChatStorageMutation", {
        configurable: true,
        value: (): void => {
          Object.defineProperty(storagePrototype, mutationMethod, {
            configurable: true,
            value: originalMethod,
            writable: true,
          });
        },
      });
    },
    {
      mutationMethod: method,
      keyToFail: storageKey,
    },
  );
};

const restoreSessionStorageMutation = async (page: Page): Promise<void> => {
  await page.evaluate((): void => {
    const restore =
      (window as StorageMutationTestWindow).__restoreChatStorageMutation;
    if (restore === undefined) {
      throw new Error("Storage mutation restore callback is missing");
    }
    restore();
  });
};

const getNavigationLink = (page: Page, href: NavigationHref): Locator =>
  page.getByRole("navigation").locator(`a[href="${href}"]`);

const mockWorkspaceClientDependencies = async (page: Page): Promise<void> => {
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

type DelayedChatBootstrap = Readonly<{
  catalogRequestReceived: Promise<void>;
  releaseCatalog: () => void;
  snapshotSessionIds: Array<string>;
}>;

const mockDelayedChatBootstrap = async (
  page: Page,
  sessionIds: ReadonlyArray<string>,
): Promise<DelayedChatBootstrap> => {
  const catalogRequestReceived = createDeferred();
  const releaseCatalog = createDeferred();
  const snapshotSessionIds: Array<string> = [];
  const lastMessageAt = new Date().toISOString();

  await mockWorkspaceClientDependencies(page);
  await page.route(/\/api\/chat\/sessions\?/u, async (route): Promise<void> => {
    catalogRequestReceived.resolve();
    await releaseCatalog.promise;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessions: sessionIds.map((sessionId) => ({
          sessionId,
          title: sessionId,
          lastMessageAt,
          status: "idle",
          mainContentInvalidationVersion: 0,
        })),
        nextCursor: null,
      }),
    });
  });
  await page.route(
    /\/api\/chat\?sessionId=/u,
    async (route): Promise<void> => {
      const sessionId = new URL(route.request().url()).searchParams.get(
        "sessionId",
      );
      if (sessionId === null) {
        throw new Error("Chat snapshot request is missing sessionId");
      }
      snapshotSessionIds.push(sessionId);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sessionId,
          runState: "idle",
          activeTurnId: null,
          updatedAt: Date.now(),
          mainContentInvalidationVersion: 0,
          messages: [],
        }),
      });
    },
  );

  return {
    catalogRequestReceived: catalogRequestReceived.promise,
    releaseCatalog: releaseCatalog.resolve,
    snapshotSessionIds,
  };
};

test("keeps an unsent chat draft within one tab", async ({ page, baseURL, context }) => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }

  const origin = new URL(baseURL);
  const catalogRequests: Array<string> = [];
  page.on("request", (request): void => {
    const url = new URL(request.url());
    if (url.pathname === "/api/chat/sessions") {
      catalogRequests.push(request.url());
    }
  });
  await context.addCookies([
    { name: "demo", value: "true", domain: origin.hostname, path: "/", sameSite: "Lax" },
    { name: "locale", value: "en", domain: origin.hostname, path: "/", sameSite: "Lax" },
    { name: "chat-open", value: "true", domain: origin.hostname, path: "/", sameSite: "Lax" },
  ]);

  await page.goto("/transactions", { waitUntil: "domcontentloaded" });
  const composer = page.getByTestId("chat-composer-input");
  await expect(composer).toBeEditable();
  await composer.fill("unsent draft");

  await page.getByTestId("chat-sidebar-close").click();
  await expect(composer).toHaveCount(0);
  await page.getByTestId("chat-sidebar-open").click();
  await expect(page.getByTestId("chat-composer-input")).toHaveValue("unsent draft");

  await getNavigationLink(page, "/chat").click();
  await expect(page).toHaveURL(
    (url) => url.pathname === "/chat",
    { timeout: localNavigationTimeoutMs },
  );
  await expect(page.getByTestId("chat-composer-input")).toHaveValue("unsent draft");

  await getNavigationLink(page, "/transactions").click();
  await expect(page).toHaveURL(
    (url) => url.pathname === "/transactions",
    { timeout: localNavigationTimeoutMs },
  );
  await expect(page.getByTestId("chat-composer-input")).toHaveValue("unsent draft");

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("chat-composer-input")).toHaveValue("unsent draft");

  const secondTab = await context.newPage();
  await secondTab.goto("/transactions", { waitUntil: "domcontentloaded" });
  await expect(secondTab.getByTestId("chat-composer-input")).toHaveValue("");
  await secondTab.close();

  await page.getByTestId("chat-composer-input").fill("");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("chat-composer-input")).toHaveValue("");
  expect(catalogRequests).toEqual([]);
});

test("reopens the same unsent draft after reloading a selected session", async ({
  page,
  baseURL,
  context,
}) => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }

  const sessionId = "session-selected";
  const activeDraftStorageKey =
    "expense-tracker-chat-active-draft:v1:workspace:local:local";
  const lastMessageAt = new Date().toISOString();
  await mockWorkspaceClientDependencies(page);
  await page.route(/\/api\/chat\/sessions\?/u, async (route): Promise<void> => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessions: [{
          sessionId,
          title: "Selected session",
          lastMessageAt,
          status: "idle",
          mainContentInvalidationVersion: 0,
        }],
        nextCursor: null,
      }),
    });
  });
  await page.route(
    /\/api\/chat\?sessionId=/u,
    async (route): Promise<void> => {
      const requestedSessionId = new URL(
        route.request().url(),
      ).searchParams.get("sessionId");
      if (requestedSessionId !== sessionId) {
        throw new Error(
          `Unexpected chat snapshot sessionId: ${String(requestedSessionId)}`,
        );
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sessionId,
          runState: "idle",
          activeTurnId: null,
          updatedAt: Date.now(),
          mainContentInvalidationVersion: 0,
          messages: [],
        }),
      });
    },
  );

  const origin = new URL(baseURL);
  await context.addCookies([
    { name: "locale", value: "en", domain: origin.hostname, path: "/", sameSite: "Lax" },
  ]);
  await page.goto("/chat", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("chat-composer-input")).toBeEditable();

  await page.getByTestId("chat-new").click();
  const composer = page.getByTestId("chat-composer-input");
  await expect(composer).toBeEditable();
  await composer.fill("draft retained while a session is selected");
  const draftIdBeforeReload = await page.evaluate(
    (storageKey: string): string | null =>
      window.sessionStorage.getItem(storageKey),
    activeDraftStorageKey,
  );
  expect(draftIdBeforeReload).toMatch(/^draft-/u);

  await page.getByTestId("chat-history-open").click();
  await page.getByTestId(`chat-history-session-${sessionId}`).click();
  await expect(page).toHaveURL(
    (url) => url.pathname === "/chat"
      && url.searchParams.get("session") === sessionId,
  );
  await expect(composer).toHaveValue("");

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(
    (url) => url.pathname === "/chat"
      && url.searchParams.get("session") === sessionId,
  );
  await expect(page.getByTestId("chat-composer-input")).toBeEditable();

  await page.getByTestId("chat-new").click();
  await expect(page).toHaveURL(
    (url) => url.pathname === "/chat"
      && !url.searchParams.has("session"),
  );
  await expect(page.getByTestId("chat-composer-input")).toHaveValue(
    "draft retained while a session is selected",
  );
  expect(await page.evaluate(
    (storageKey: string): string | null =>
      window.sessionStorage.getItem(storageKey),
    activeDraftStorageKey,
  )).toBe(draftIdBeforeReload);
});

test("reevaluates an automatic draft on reload but restores an explicit draft", async ({
  page,
  baseURL,
  context,
}) => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }

  await page.addInitScript((): void => {
    class ImmediateMediaRecorder extends EventTarget {
      public static isTypeSupported(_mimeType: string): boolean {
        return true;
      }

      public state: RecordingState = "inactive";
      public readonly mimeType: string;

      public constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
        super();
        this.mimeType = options?.mimeType ?? "audio/webm";
      }

      public start(): void {
        this.state = "recording";
      }

      public stop(): void {
        if (this.state === "inactive") {
          return;
        }
        this.state = "inactive";
        this.dispatchEvent(new BlobEvent("dataavailable", {
          data: new Blob(["automatic selection audio"], {
            type: this.mimeType,
          }),
        }));
        this.dispatchEvent(new Event("stop"));
      }
    }

    const mediaStream = {
      getTracks: (): ReadonlyArray<Readonly<{ stop: () => void }>> => [{
        stop: (): void => undefined,
      }],
    };
    Object.defineProperty(window, "MediaRecorder", {
      configurable: true,
      value: ImmediateMediaRecorder,
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async (): Promise<typeof mediaStream> => mediaStream,
      },
    });
  });

  const sessionId = "session-policy";
  const selectionStorageKey =
    "expense-tracker-chat-selection:v1:workspace:local:local";
  let catalogStatus: "idle" | "running" = "idle";
  let snapshotRequestCount = 0;
  await mockWorkspaceClientDependencies(page);
  await page.route(/\/api\/chat\/sessions\?/u, async (route): Promise<void> => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessions: [{
          sessionId,
          title: "Policy session",
          lastMessageAt: catalogStatus === "running"
            ? new Date().toISOString()
            : new Date(Date.now() - (7 * 60 * 60 * 1000)).toISOString(),
          status: catalogStatus,
          mainContentInvalidationVersion: 0,
        }],
        nextCursor: null,
      }),
    });
  });
  await page.route(
    /\/api\/chat\?sessionId=/u,
    async (route): Promise<void> => {
      snapshotRequestCount += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sessionId,
          runState: "running",
          activeTurnId: RUNNING_SNAPSHOT_TURN_ID,
          updatedAt: Date.now(),
          mainContentInvalidationVersion: 0,
          messages: [{
            messageId: PERSISTED_SNAPSHOT_MESSAGE_ID,
            role: "assistant",
            content: [{
              type: "text",
              text: "Automatic session transcript",
            }],
            timestamp: Date.now(),
            isError: false,
            isStopped: false,
          }],
        }),
      });
    },
  );
  await page.route("**/api/chat/transcriptions", async (route): Promise<void> => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ text: "automatic dictation" }),
    });
  });

  const origin = new URL(baseURL);
  await context.addCookies([
    { name: "locale", value: "en", domain: origin.hostname, path: "/", sameSite: "Lax" },
  ]);
  await page.goto("/chat", { waitUntil: "domcontentloaded" });
  const composer = page.getByTestId("chat-composer-input");
  await expect(composer).toBeEditable();
  await expect(page.getByTestId("chat-submit")).toHaveText("Send");
  expect(await page.evaluate(
    (storageKey: string): string | null =>
      window.sessionStorage.getItem(storageKey),
    selectionStorageKey,
  )).toBeNull();

  catalogStatus = "running";
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect.poll(() => snapshotRequestCount).toBe(1);
  await expect(page.getByTestId("chat-submit")).toHaveText("Stop");

  const assertAutomaticPromotionPreservesLifecycle = async (
    marker: string,
    snapshotCount: number,
    url: string,
  ): Promise<void> => {
    await expect.poll(async (): Promise<string | null> =>
      page.evaluate(
        (storageKey: string): string | null =>
          window.sessionStorage.getItem(storageKey),
        selectionStorageKey,
      )).toContain("\"selectionReason\":\"explicit\"");
    await expect(page).toHaveURL(url);
    await expect(page.getByTestId("chat-submit")).toHaveText("Stop");
    expect(snapshotRequestCount).toBe(snapshotCount);
    expect(await composer.evaluate((element): string | undefined =>
      (element as HTMLTextAreaElement & {
        __automaticPromotionMarker?: string;
      }).__automaticPromotionMarker)).toBe(marker);
    expect(await page.getByTestId("chat-panel").evaluate(
      (element): string | undefined => element.dataset.promotionMarker,
    )).toBe(marker);
  };
  const markAutomaticLifecycle = async (marker: string): Promise<{
    snapshotCount: number;
    url: string;
  }> => {
    await composer.evaluate((element, nextMarker): void => {
      const textarea = element as HTMLTextAreaElement & {
        __automaticPromotionMarker?: string;
      };
      textarea.__automaticPromotionMarker = nextMarker;
    }, marker);
    await page.getByTestId("chat-panel").evaluate(
      (element, nextMarker): void => {
        element.dataset.promotionMarker = nextMarker;
      },
      marker,
    );
    return {
      snapshotCount: snapshotRequestCount,
      url: page.url(),
    };
  };
  const reloadAutomaticSession = async (): Promise<void> => {
    await page.evaluate((storageKey: string): void => {
      window.sessionStorage.removeItem(storageKey);
    }, selectionStorageKey);
    const previousSnapshotCount = snapshotRequestCount;
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect.poll(() => snapshotRequestCount).toBe(
      previousSnapshotCount + 1,
    );
    await expect(page.getByTestId("chat-submit")).toHaveText("Stop");
  };

  const editLifecycle = await markAutomaticLifecycle("edit");
  await composer.fill("automatic session edit");
  await assertAutomaticPromotionPreservesLifecycle(
    "edit",
    editLifecycle.snapshotCount,
    editLifecycle.url,
  );
  await composer.fill("");

  await reloadAutomaticSession();
  const attachmentLifecycle = await markAutomaticLifecycle("attachment");
  await page.getByTestId("chat-file-input").setInputFiles({
    name: "automatic-session.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("automatic session attachment"),
  });
  await expect(page.getByTestId("chat-prepared-attachment")).toContainText(
    "automatic-session.txt",
  );
  await assertAutomaticPromotionPreservesLifecycle(
    "attachment",
    attachmentLifecycle.snapshotCount,
    attachmentLifecycle.url,
  );

  await reloadAutomaticSession();
  const dictationLifecycle = await markAutomaticLifecycle("dictation");
  await page.getByTestId("chat-dictation").click();
  await expect(page.getByTestId("chat-dictation")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await assertAutomaticPromotionPreservesLifecycle(
    "dictation",
    dictationLifecycle.snapshotCount,
    dictationLifecycle.url,
  );
  await page.getByTestId("chat-dictation").click();
  await expect(composer).toHaveValue("automatic dictation");

  await page.getByTestId("chat-new").click();
  await composer.fill("discard this automatic draft");
  await page.getByTestId("chat-new").click();
  await composer.fill("restore this explicit draft");
  expect(await page.evaluate(
    (storageKey: string): string | null =>
      window.sessionStorage.getItem(storageKey),
    selectionStorageKey,
  )).toContain("\"selectionReason\":\"explicit\"");

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(composer).toHaveValue("restore this explicit draft");
  await expect(page.getByTestId("chat-submit")).toHaveText("Send");
  expect(snapshotRequestCount).toBe(3);
});

test("keeps an edited automatic draft selected while History refreshes", async ({
  page,
  baseURL,
  context,
}) => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }

  const sessionId = "session-arriving-during-history-refresh";
  const selectionStorageKey =
    "expense-tracker-chat-selection:v1:workspace:local:local";
  let catalogRequestCount = 0;
  let snapshotRequestCount = 0;
  await mockWorkspaceClientDependencies(page);
  await page.route(/\/api\/chat\/sessions\?/u, async (route): Promise<void> => {
    catalogRequestCount += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessions: catalogRequestCount === 1
          ? []
          : [{
            sessionId,
            title: "Newly active session",
            lastMessageAt: new Date().toISOString(),
            status: "running",
            mainContentInvalidationVersion: 0,
          }],
        nextCursor: null,
      }),
    });
  });
  await page.route(
    /\/api\/chat\?sessionId=/u,
    async (route): Promise<void> => {
      snapshotRequestCount += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sessionId,
          runState: "running",
          activeTurnId: RUNNING_SNAPSHOT_TURN_ID,
          updatedAt: Date.now(),
          mainContentInvalidationVersion: 0,
          messages: [],
        }),
      });
    },
  );

  const origin = new URL(baseURL);
  await context.addCookies([
    { name: "locale", value: "en", domain: origin.hostname, path: "/", sameSite: "Lax" },
  ]);
  await page.goto("/chat", { waitUntil: "domcontentloaded" });
  const composer = page.getByTestId("chat-composer-input");
  await expect(composer).toBeEditable();
  await composer.fill("keep this edited automatic draft");
  await expect.poll(async (): Promise<string | null> =>
    page.evaluate(
      (storageKey: string): string | null =>
        window.sessionStorage.getItem(storageKey),
      selectionStorageKey,
    )).toContain("\"selectionReason\":\"explicit\"");

  await page.getByTestId("chat-history-open").click();
  await expect(
    page.getByTestId(`chat-history-session-${sessionId}`),
  ).toBeVisible();
  await expect(page).toHaveURL(
    (url) => url.pathname === "/chat" && url.searchParams.get("session") === null,
  );
  await expect(composer).toHaveValue("keep this edited automatic draft");
  expect(snapshotRequestCount).toBe(0);
});

test("keeps History selection unchanged when explicit persistence fails", async ({
  page,
  baseURL,
  context,
}) => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }

  const sessionA = "session-history-storage-a";
  const sessionB = "session-history-storage-b";
  const selectionStorageKey =
    "expense-tracker-chat-selection:v1:workspace:local:local";
  const lastMessageAt = new Date().toISOString();
  const pageErrors: Array<string> = [];
  page.on("pageerror", (error): void => {
    pageErrors.push(error.message);
  });
  await mockWorkspaceClientDependencies(page);
  await page.route(/\/api\/chat\/sessions\?/u, async (route): Promise<void> => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessions: [sessionA, sessionB].map((sessionId) => ({
          sessionId,
          title: sessionId,
          lastMessageAt,
          status: "idle",
          mainContentInvalidationVersion: 0,
        })),
        nextCursor: null,
      }),
    });
  });
  await page.route(
    /\/api\/chat\?sessionId=/u,
    async (route): Promise<void> => {
      const sessionId = new URL(route.request().url()).searchParams.get(
        "sessionId",
      );
      if (sessionId !== sessionA && sessionId !== sessionB) {
        throw new Error(
          `Unexpected History storage test session: ${String(sessionId)}`,
        );
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sessionId,
          runState: "idle",
          activeTurnId: null,
          updatedAt: Date.now(),
          mainContentInvalidationVersion: 0,
          messages: [],
        }),
      });
    },
  );

  const origin = new URL(baseURL);
  await context.addCookies([
    { name: "locale", value: "en", domain: origin.hostname, path: "/", sameSite: "Lax" },
  ]);
  await page.goto(`/chat?session=${sessionA}`, {
    waitUntil: "domcontentloaded",
  });
  const composer = page.getByTestId("chat-composer-input");
  await expect(composer).toBeEditable();
  const previousSelection = await page.evaluate(
    (storageKey: string): string | null =>
      window.sessionStorage.getItem(storageKey),
    selectionStorageKey,
  );
  expect(previousSelection).toContain(sessionA);

  await page.getByTestId("chat-history-open").click();
  await expect(
    page.getByTestId(`chat-history-session-${sessionB}`),
  ).toBeVisible();
  await failNextSessionStorageMutation(
    page,
    "setItem",
    selectionStorageKey,
  );
  await page.getByTestId(`chat-history-session-${sessionB}`).evaluate(
    (button: HTMLElement): void => button.click(),
  );
  await expect.poll(async (): Promise<boolean> =>
    page.evaluate((): boolean =>
      (window as StorageMutationTestWindow).__chatStorageMutationFailed
        === true),
  ).toBe(true);
  await expect.poll((): number => pageErrors.length).toBe(1);
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("session") === sessionA,
  );
  await expect(composer).toBeEditable();
  expect(await page.evaluate(
    (storageKey: string): string | null =>
      window.sessionStorage.getItem(storageKey),
    selectionStorageKey,
  )).toBe(previousSelection);

  await restoreSessionStorageMutation(page);
  await page.getByTestId(`chat-history-session-${sessionB}`).click();
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("session") === sessionB,
  );
  await expect(composer).toBeEditable();
  expect(pageErrors).toHaveLength(1);
});

test("does not promote a recovered automatic target from stale dictation", async ({
  page,
  baseURL,
  context,
}) => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }

  await page.addInitScript((): void => {
    const mediaStream = {
      getTracks: (): ReadonlyArray<Readonly<{ stop: () => void }>> => [{
        stop: (): void => undefined,
      }],
    };
    let resolvePermission: ((stream: typeof mediaStream) => void) | null = null;
    const permission = new Promise<typeof mediaStream>((resolve): void => {
      resolvePermission = resolve;
    });
    if (resolvePermission === null) {
      throw new Error("Failed to create deferred microphone permission");
    }
    Object.defineProperty(
      window,
      "__resolveChatMicrophonePermission",
      {
        configurable: true,
        value: (): void => resolvePermission?.(mediaStream),
      },
    );
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async (): Promise<typeof mediaStream> => permission,
      },
    });
  });

  const sessionA = "session-dictation-recovery-a";
  const sessionB = "session-dictation-recovery-b";
  const snapshotCounts = new Map<string, number>();
  const selectionStorageKey =
    "expense-tracker-chat-selection:v1:workspace:local:local";
  await mockWorkspaceClientDependencies(page);
  await page.route(/\/api\/chat\/sessions\?/u, async (route): Promise<void> => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessions: [sessionA, sessionB].map((sessionId) => ({
          sessionId,
          title: sessionId,
          lastMessageAt: new Date().toISOString(),
          status: "running",
          mainContentInvalidationVersion: 0,
        })),
        nextCursor: null,
      }),
    });
  });
  await page.route(
    /\/api\/chat\?sessionId=/u,
    async (route): Promise<void> => {
      const sessionId = new URL(route.request().url()).searchParams.get(
        "sessionId",
      );
      if (sessionId !== sessionA && sessionId !== sessionB) {
        throw new Error(
          `Unexpected dictation recovery sessionId: ${String(sessionId)}`,
        );
      }
      const requestCount = (snapshotCounts.get(sessionId) ?? 0) + 1;
      snapshotCounts.set(sessionId, requestCount);
      if (sessionId === sessionA && requestCount > 1) {
        await route.fulfill({
          status: 404,
          contentType: "text/plain",
          body: "Selected dictation session is unavailable",
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sessionId,
          runState: sessionId === sessionA ? "running" : "idle",
          activeTurnId: sessionId === sessionA
            ? RUNNING_SNAPSHOT_TURN_ID
            : null,
          updatedAt: Date.now(),
          mainContentInvalidationVersion: 0,
          messages: [],
        }),
      });
    },
  );

  const origin = new URL(baseURL);
  await context.addCookies([
    { name: "locale", value: "en", domain: origin.hostname, path: "/", sameSite: "Lax" },
  ]);
  await page.goto("/chat", { waitUntil: "domcontentloaded" });
  await expect.poll((): number => snapshotCounts.get(sessionA) ?? 0).toBe(1);
  await expect(page.getByTestId("chat-submit")).toHaveText("Stop");
  await page.getByTestId("chat-dictation").click();
  await expect(page.getByTestId("chat-dictation")).toBeDisabled();
  await expect.poll(async (): Promise<string | null> =>
    page.evaluate(
      (storageKey: string): string | null =>
        window.sessionStorage.getItem(storageKey),
      selectionStorageKey,
    )).toContain(sessionA);

  await expect(page).toHaveURL(
    (url) => url.searchParams.get("session") === sessionB,
    { timeout: 15_000 },
  );
  await expect.poll((): number => snapshotCounts.get(sessionB) ?? 0)
    .toBeGreaterThanOrEqual(1);
  expect(await page.evaluate(
    (storageKey: string): string | null =>
      window.sessionStorage.getItem(storageKey),
    selectionStorageKey,
  )).toBeNull();

  await page.evaluate((): void => {
    const resolvePermission =
      (window as DictationTestWindow).__resolveChatMicrophonePermission;
    if (resolvePermission === undefined) {
      throw new Error("Deferred microphone permission resolver is missing");
    }
    resolvePermission();
  });
  await expect(page.getByTestId("chat-composer-input")).toBeEditable();
  expect(await page.evaluate(
    (storageKey: string): string | null =>
      window.sessionStorage.getItem(storageKey),
    selectionStorageKey,
  )).toBeNull();
});

test("cancels pending dictation after a batched session round trip", async ({
  page,
  baseURL,
  context,
}) => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }

  await page.addInitScript((): void => {
    let permissionRequestCount = 0;
    let trackStopCount = 0;
    const mediaStream = {
      getTracks: (): ReadonlyArray<Readonly<{ stop: () => void }>> => [{
        stop: (): void => {
          trackStopCount += 1;
        },
      }],
    };
    let resolvePermission: ((stream: typeof mediaStream) => void) | null = null;
    const permission = new Promise<typeof mediaStream>((resolve): void => {
      resolvePermission = resolve;
    });
    if (resolvePermission === null) {
      throw new Error("Failed to create deferred microphone permission");
    }
    Object.defineProperties(window, {
      __resolveChatMicrophonePermission: {
        configurable: true,
        value: (): void => resolvePermission?.(mediaStream),
      },
      __chatMicrophonePermissionRequestCount: {
        configurable: true,
        get: (): number => permissionRequestCount,
      },
      __chatMicrophoneTrackStopCount: {
        configurable: true,
        get: (): number => trackStopCount,
      },
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async (): Promise<typeof mediaStream> => {
          permissionRequestCount += 1;
          return permission;
        },
      },
    });
  });

  const sessionA = "session-dictation-round-trip-a";
  const sessionB = "session-dictation-round-trip-b";
  const snapshotCounts = new Map<string, number>();
  let transcriptionRequestCount = 0;
  const pageErrors: Array<string> = [];
  const dialogMessages: Array<string> = [];
  page.on("pageerror", (error): void => {
    pageErrors.push(error.message);
  });
  page.on("dialog", (dialog): void => {
    dialogMessages.push(dialog.message());
    void dialog.dismiss();
  });

  await mockWorkspaceClientDependencies(page);
  await page.route(/\/api\/chat\/sessions\?/u, async (route): Promise<void> => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessions: [sessionA, sessionB].map((sessionId) => ({
          sessionId,
          title: sessionId,
          lastMessageAt: new Date().toISOString(),
          status: "idle",
          mainContentInvalidationVersion: 0,
        })),
        nextCursor: null,
      }),
    });
  });
  await page.route(
    /\/api\/chat\?sessionId=/u,
    async (route): Promise<void> => {
      const sessionId = new URL(route.request().url()).searchParams.get(
        "sessionId",
      );
      if (sessionId !== sessionA && sessionId !== sessionB) {
        throw new Error(
          `Unexpected dictation round-trip sessionId: ${String(sessionId)}`,
        );
      }
      snapshotCounts.set(
        sessionId,
        (snapshotCounts.get(sessionId) ?? 0) + 1,
      );
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sessionId,
          runState: "idle",
          activeTurnId: null,
          updatedAt: Date.now(),
          mainContentInvalidationVersion: 0,
          messages: [],
        }),
      });
    },
  );
  await page.route(
    "**/api/chat/transcriptions",
    async (route): Promise<void> => {
      transcriptionRequestCount += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ text: "unexpected stale transcript" }),
      });
    },
  );

  const origin = new URL(baseURL);
  await context.addCookies([
    { name: "locale", value: "en", domain: origin.hostname, path: "/", sameSite: "Lax" },
  ]);
  await page.goto(`/chat?session=${sessionA}`, {
    waitUntil: "domcontentloaded",
  });
  const composer = page.getByTestId("chat-composer-input");
  const dictationButton = page.getByTestId("chat-dictation");
  await expect(composer).toBeEditable();
  await composer.fill("text owned by session A");
  await dictationButton.click();
  await expect(dictationButton).toBeDisabled();
  await expect.poll(async (): Promise<number | undefined> =>
    page.evaluate((): number | undefined =>
      (window as DictationTestWindow)
        .__chatMicrophonePermissionRequestCount)).toBe(1);

  await page.evaluate(({ firstSessionId, secondSessionId }): void => {
    window.history.pushState(
      window.history.state,
      "",
      `/chat?session=${encodeURIComponent(secondSessionId)}`,
    );
    window.dispatchEvent(new PopStateEvent("popstate"));
    window.history.pushState(
      window.history.state,
      "",
      `/chat?session=${encodeURIComponent(firstSessionId)}`,
    );
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, {
    firstSessionId: sessionA,
    secondSessionId: sessionB,
  });
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("session") === sessionA,
  );
  await expect.poll((): number => snapshotCounts.get(sessionA) ?? 0)
    .toBeGreaterThanOrEqual(2);

  await page.evaluate((): void => {
    const resolvePermission =
      (window as DictationTestWindow).__resolveChatMicrophonePermission;
    if (resolvePermission === undefined) {
      throw new Error("Deferred microphone permission resolver is missing");
    }
    resolvePermission();
  });
  await expect.poll(async (): Promise<number | undefined> =>
    page.evaluate((): number | undefined =>
      (window as DictationTestWindow).__chatMicrophoneTrackStopCount)).toBe(1);

  await expect(composer).toBeEditable();
  await expect(composer).toHaveValue("text owned by session A");
  await expect(dictationButton).toBeEnabled();
  await expect(dictationButton).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("chat-file-input")).toBeEnabled();
  await expect(page.getByTestId("chat-submit")).toBeEnabled();
  await expect(page.getByTestId("chat-attachment-error")).toHaveCount(0);
  expect(transcriptionRequestCount).toBe(0);
  expect(dialogMessages).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("focuses the new composer from the header and History dialog", async ({
  page,
  baseURL,
  context,
}) => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }

  const origin = new URL(baseURL);
  await context.addCookies([
    { name: "demo", value: "true", domain: origin.hostname, path: "/", sameSite: "Lax" },
    { name: "locale", value: "en", domain: origin.hostname, path: "/", sameSite: "Lax" },
  ]);
  await page.goto("/chat", { waitUntil: "domcontentloaded" });

  const composer = page.getByTestId("chat-composer-input");
  await composer.fill("replace from the header");
  await page.getByTestId("chat-new").click();
  await expect(composer).toHaveValue("");
  await expect(composer).toBeFocused();

  await composer.fill("replace from History");
  await page.getByTestId("chat-history-open").click();
  await page.getByTestId("chat-history-new").click();
  await expect(page.getByTestId("chat-history-dialog")).not.toBeVisible();
  await expect(composer).toHaveValue("");
  await expect(composer).toBeFocused();
});

test("retains New focus until slow workspace bootstrap enables the composer", async ({
  page,
  baseURL,
  context,
}) => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }

  const bootstrap = await mockDelayedChatBootstrap(page, []);
  const origin = new URL(baseURL);
  await context.addCookies([
    { name: "locale", value: "en", domain: origin.hostname, path: "/", sameSite: "Lax" },
  ]);
  await page.goto("/chat", { waitUntil: "domcontentloaded" });
  await bootstrap.catalogRequestReceived;

  const composer = page.getByTestId("chat-composer-input");
  await expect(composer).toBeDisabled();
  await page.getByTestId("chat-new").click();
  await expect(composer).not.toBeFocused();

  bootstrap.releaseCatalog();
  await expect(composer).toBeEditable();
  await expect(composer).toBeFocused();
});

test("restores a failed first submission without overwriting follow-up edits", async ({
  page,
  baseURL,
  context,
}) => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }

  const sessionId = "session-switch-target";
  const firstRequestReceived = createDeferred();
  const releaseFirstFailure = createDeferred();
  const secondRequestReceived = createDeferred();
  const releaseSecondFailure = createDeferred();
  let newChatRequestCount = 0;
  await mockWorkspaceClientDependencies(page);
  await page.route(/\/api\/chat\/sessions\?/u, async (route): Promise<void> => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessions: [{
          sessionId,
          title: "Switch target",
          lastMessageAt: new Date(
            Date.now() - (7 * 60 * 60 * 1000),
          ).toISOString(),
          status: "idle",
          mainContentInvalidationVersion: 0,
        }],
        nextCursor: null,
      }),
    });
  });
  await page.route(
    /\/api\/chat\?sessionId=/u,
    async (route): Promise<void> => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sessionId,
          runState: "idle",
          activeTurnId: null,
          updatedAt: Date.now(),
          mainContentInvalidationVersion: 0,
          messages: [],
        }),
      });
    },
  );
  await page.route("**/api/chat/new", async (route): Promise<void> => {
    newChatRequestCount += 1;
    if (newChatRequestCount === 1) {
      firstRequestReceived.resolve();
      await releaseFirstFailure.promise;
    } else if (newChatRequestCount === 2) {
      secondRequestReceived.resolve();
      await releaseSecondFailure.promise;
    }
    await route.fulfill({
      status: 400,
      contentType: "text/plain",
      body: "Fresh chat request failed",
    });
  });

  const origin = new URL(baseURL);
  await context.addCookies([
    { name: "locale", value: "en", domain: origin.hostname, path: "/", sameSite: "Lax" },
  ]);
  await page.goto("/chat", { waitUntil: "domcontentloaded" });
  const composer = page.getByTestId("chat-composer-input");
  await expect(composer).toBeEditable();
  await composer.fill("original failed prompt");
  await page.getByTestId("chat-file-input").setInputFiles({
    name: "original.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("original attachment bytes"),
  });
  await expect(page.getByTestId("chat-prepared-attachment")).toContainText(
    "original.txt",
  );
  await page.getByTestId("chat-submit").click();
  await firstRequestReceived.promise;
  await page.getByTestId("chat-history-open").click();
  await page.getByTestId(`chat-history-session-${sessionId}`).click();
  await expect(composer).toHaveValue("");
  releaseFirstFailure.resolve();
  await page.getByTestId("chat-new").click();
  await expect(composer).toHaveValue("original failed prompt");
  await expect(page.getByTestId("chat-prepared-attachment")).toContainText(
    "original.txt",
  );

  await page.getByTestId("chat-submit").click();
  await secondRequestReceived.promise;
  await composer.fill("follow-up edit");
  await page.getByTestId("chat-file-input").setInputFiles({
    name: "follow-up.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("follow-up attachment bytes"),
  });
  await expect(page.getByTestId("chat-prepared-attachment")).toContainText(
    "follow-up.txt",
  );
  releaseSecondFailure.resolve();

  await expect(composer).toHaveValue("follow-up edit");
  await expect(page.getByTestId("chat-prepared-attachment")).toContainText(
    "follow-up.txt",
  );
  await expect(page.getByTestId("chat-prepared-attachment")).not.toContainText(
    "original.txt",
  );
});

test("does not retry an ambiguous first-send failure", async ({
  page,
  baseURL,
  context,
}) => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }

  let createRequestCount = 0;
  await page.route("**/api/chat/new", async (route): Promise<void> => {
    createRequestCount += 1;
    await route.fulfill({
      status: 503,
      contentType: "text/plain",
      body: "Upstream response unavailable",
    });
  });

  const origin = new URL(baseURL);
  await context.addCookies([
    { name: "demo", value: "true", domain: origin.hostname, path: "/", sameSite: "Lax" },
    { name: "locale", value: "en", domain: origin.hostname, path: "/", sameSite: "Lax" },
  ]);
  await page.goto("/chat", { waitUntil: "domcontentloaded" });
  const composer = page.getByTestId("chat-composer-input");
  const submit = page.getByTestId("chat-submit");
  await composer.fill("do not create this twice");
  await page.getByTestId("chat-file-input").setInputFiles({
    name: "uncertain.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("uncertain bytes"),
  });
  await submit.click();

  await expect(composer).toHaveValue("do not create this twice");
  await expect(page.getByTestId("chat-prepared-attachment")).toContainText(
    "uncertain.txt",
  );
  await expect(submit).toBeDisabled();
  await submit.evaluate((button: HTMLElement): void => button.click());
  expect(createRequestCount).toBe(1);
  const unresolvedDraftStorageKeys = await page.evaluate(
    (expectedText: string): ReadonlyArray<string> =>
      Object.keys(window.sessionStorage).filter(
        (storageKey: string): boolean =>
          storageKey.startsWith("expense-tracker-chat-draft:v2:")
          && window.sessionStorage.getItem(storageKey) === expectedText,
      ),
    "do not create this twice",
  );
  expect(unresolvedDraftStorageKeys).toHaveLength(1);

  await page.getByTestId("chat-new").click();
  await expect(composer).toHaveValue("");
  await expect(page.getByTestId("chat-prepared-attachment")).toHaveCount(0);
  await expect.poll(async (): Promise<ReadonlyArray<string>> =>
    page.evaluate(
      (expectedText: string): ReadonlyArray<string> =>
        Object.keys(window.sessionStorage).filter(
          (storageKey: string): boolean =>
            storageKey.startsWith("expense-tracker-chat-draft:v2:")
            && window.sessionStorage.getItem(storageKey) === expectedText,
        ),
      "do not create this twice",
    )).toEqual([]);
  expect(createRequestCount).toBe(1);
});

for (const settlementCase of [
  {
    kind: "rejected",
    status: 400,
    errorText: "Rejected chat submission settlement failed",
  },
  {
    kind: "unresolved",
    status: 503,
    errorText: "Unresolved chat submission settlement failed",
  },
] as const) {
  test(`recovers ${settlementCase.kind} settlement after draft storage failure`, async ({
    page,
    baseURL,
    context,
  }) => {
    if (baseURL === undefined) {
      throw new Error("Local Demo Playwright baseURL is required");
    }

    const firstRequestReceived = createDeferred();
    const releaseFirstResponse = createDeferred();
    const pageErrors: Array<string> = [];
    let createRequestCount = 0;
    page.on("pageerror", (error): void => {
      pageErrors.push(error.message);
    });
    await mockWorkspaceClientDependencies(page);
    await page.route(/\/api\/chat\/sessions\?/u, async (route): Promise<void> => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ sessions: [], nextCursor: null }),
      });
    });
    await page.route(
      /\/api\/chat\?sessionId=/u,
      async (route): Promise<void> => {
        const sessionId = new URL(route.request().url()).searchParams.get(
          "sessionId",
        );
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            sessionId,
            runState: "idle",
            activeTurnId: null,
            updatedAt: Date.now(),
            mainContentInvalidationVersion: 0,
            messages: [],
          }),
        });
      },
    );
    await page.route("**/api/chat/new", async (route): Promise<void> => {
      createRequestCount += 1;
      if (createRequestCount === 1) {
        firstRequestReceived.resolve();
        await releaseFirstResponse.promise;
        await route.fulfill({
          status: settlementCase.status,
          contentType: "text/plain",
          body: `${settlementCase.kind} first submission`,
        });
        return;
      }
      await route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "X-Chat-Session-Id": "session-settlement-retry",
        },
        body: [
          "data: {\"type\":\"session\",\"sessionId\":\"session-settlement-retry\"}",
          "data: {\"type\":\"done\"}",
          "",
        ].join("\n\n"),
      });
    });

    const origin = new URL(baseURL);
    await context.addCookies([
      { name: "demo", value: "true", domain: origin.hostname, path: "/", sameSite: "Lax" },
      { name: "locale", value: "en", domain: origin.hostname, path: "/", sameSite: "Lax" },
    ]);
    await page.goto("/chat", { waitUntil: "domcontentloaded" });
    const composer = page.getByTestId("chat-composer-input");
    const submit = page.getByTestId("chat-submit");
    const submittedText = `${settlementCase.kind} settlement retry prompt`;
    await composer.fill(submittedText);
    await page.getByTestId("chat-file-input").setInputFiles({
      name: `${settlementCase.kind}-settlement.txt`,
      mimeType: "text/plain",
      buffer: Buffer.from(`${settlementCase.kind} settlement attachment`),
    });
    const draftStorageKey = await page.evaluate(
      (expectedText: string): string => {
        const storageKey = Object.keys(window.sessionStorage).find(
          (key: string): boolean =>
            key.startsWith("expense-tracker-chat-draft:v2:demo:local:")
            && window.sessionStorage.getItem(key) === expectedText,
        );
        if (storageKey === undefined) {
          throw new Error("Settlement retry draft storage key was not found");
        }
        return storageKey;
      },
      submittedText,
    );

    await submit.click();
    await firstRequestReceived.promise;
    await failNextSessionStorageMutation(
      page,
      "setItem",
      draftStorageKey,
    );
    releaseFirstResponse.resolve();

    await expect.poll(async (): Promise<number | undefined> =>
      page.evaluate((): number | undefined =>
        (window as StorageMutationTestWindow)
          .__chatStorageMutationAttemptCount)).toBe(2);
    await expect.poll((): number => pageErrors.length).toBe(1);
    expect(pageErrors[0]).toContain(settlementCase.errorText);
    await expect(composer).toHaveValue(submittedText);
    await expect(page.getByTestId("chat-prepared-attachment")).toContainText(
      `${settlementCase.kind}-settlement.txt`,
    );
    await expect(submit).toHaveText("Send");
    expect(createRequestCount).toBe(1);

    await restoreSessionStorageMutation(page);
    if (settlementCase.kind === "rejected") {
      await expect(submit).toBeEnabled();
      await submit.click();
      await expect.poll((): number => createRequestCount).toBe(2);
      await expect(page).toHaveURL(
        (url) => url.searchParams.get("session")
          === "session-settlement-retry",
      );
    } else {
      await expect(submit).toBeDisabled();
      await page.getByTestId("chat-new").click();
      await expect(composer).toHaveValue("");
      await expect(
        page.getByTestId("chat-prepared-attachment"),
      ).toHaveCount(0);
      expect(createRequestCount).toBe(1);
    }
    expect(pageErrors).toHaveLength(1);
  });
}

test("releases exact submission ownership when input storage staging fails", async ({
  page,
  baseURL,
  context,
}) => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }

  const pageErrors: Array<string> = [];
  let createRequestCount = 0;
  page.on("pageerror", (error): void => {
    pageErrors.push(error.message);
  });
  await page.route("**/api/chat/new", async (route): Promise<void> => {
    createRequestCount += 1;
    await route.fulfill({
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "X-Chat-Session-Id": "session-after-staging-retry",
      },
      body: [
        "data: {\"type\":\"session\",\"sessionId\":\"session-after-staging-retry\"}",
        "data: {\"type\":\"done\"}",
        "",
      ].join("\n\n"),
    });
  });

  const origin = new URL(baseURL);
  await context.addCookies([
    { name: "demo", value: "true", domain: origin.hostname, path: "/", sameSite: "Lax" },
    { name: "locale", value: "en", domain: origin.hostname, path: "/", sameSite: "Lax" },
  ]);
  await page.goto("/chat", { waitUntil: "domcontentloaded" });
  const composer = page.getByTestId("chat-composer-input");
  const submit = page.getByTestId("chat-submit");
  const submittedText = "retry after local submission staging failure";
  await composer.fill(submittedText);
  await page.getByTestId("chat-file-input").setInputFiles({
    name: "staging-retry.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("staging retry attachment"),
  });
  await expect(page.getByTestId("chat-prepared-attachment")).toContainText(
    "staging-retry.txt",
  );
  const draftStorageKey = await page.evaluate(
    (expectedText: string): string => {
      const storageKey = Object.keys(window.sessionStorage).find(
        (key: string): boolean =>
          key.startsWith("expense-tracker-chat-draft:v2:demo:local:")
          && window.sessionStorage.getItem(key) === expectedText,
      );
      if (storageKey === undefined) {
        throw new Error("Submission staging draft storage key was not found");
      }
      return storageKey;
    },
    submittedText,
  );
  await failNextSessionStorageMutation(
    page,
    "removeItem",
    draftStorageKey,
  );

  await submit.evaluate((button: HTMLElement): void => button.click());
  await expect.poll(async (): Promise<boolean> =>
    page.evaluate((): boolean =>
      (window as StorageMutationTestWindow).__chatStorageMutationFailed
        === true),
  ).toBe(true);
  await expect.poll((): number => pageErrors.length).toBe(1);
  expect(pageErrors[0]).toContain("Chat submission staging failed");
  expect(createRequestCount).toBe(0);
  await expect(composer).toHaveValue(submittedText);
  await expect(page.getByTestId("chat-prepared-attachment")).toContainText(
    "staging-retry.txt",
  );
  await expect(submit).toBeEnabled();

  await restoreSessionStorageMutation(page);
  await submit.evaluate((button: HTMLElement): void => button.click());
  await expect.poll((): number => createRequestCount).toBe(1);
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("session")
      === "session-after-staging-retry",
  );
  expect(pageErrors).toHaveLength(1);
});

test("keeps an abandoned draft reachable when New disposal storage fails", async ({
  page,
  baseURL,
  context,
}) => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }

  const pageErrors: Array<string> = [];
  page.on("pageerror", (error): void => {
    pageErrors.push(error.message);
  });
  await mockWorkspaceClientDependencies(page);
  await page.route(/\/api\/chat\/sessions\?/u, async (route): Promise<void> => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ sessions: [], nextCursor: null }),
    });
  });
  const origin = new URL(baseURL);
  await context.addCookies([
    { name: "demo", value: "true", domain: origin.hostname, path: "/", sameSite: "Lax" },
    { name: "locale", value: "en", domain: origin.hostname, path: "/", sameSite: "Lax" },
  ]);
  await page.goto("/chat", { waitUntil: "domcontentloaded" });

  const composer = page.getByTestId("chat-composer-input");
  const retainedText = "abandoned draft survives failed New disposal";
  await expect(composer).toBeEditable();
  await composer.fill(retainedText);
  await page.getByTestId("chat-file-input").setInputFiles({
    name: "new-disposal-retry.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("New disposal retry attachment bytes"),
  });
  await expect(page.getByTestId("chat-prepared-attachment")).toContainText(
    "new-disposal-retry.txt",
  );
  const storageBeforeNew = await page.evaluate(
    (expectedText: string): Readonly<{
      activeDraft: string | null;
      selection: string | null;
      draftStorageKey: string;
    }> => {
      const draftStorageKey = Object.keys(window.sessionStorage).find(
        (storageKey: string): boolean =>
          storageKey.startsWith("expense-tracker-chat-draft:v2:demo:local:")
          && window.sessionStorage.getItem(storageKey) === expectedText,
      );
      if (draftStorageKey === undefined) {
        throw new Error("New disposal source draft storage key was not found");
      }
      return {
        activeDraft: window.sessionStorage.getItem(
          "expense-tracker-chat-active-draft:v1:demo:local",
        ),
        selection: window.sessionStorage.getItem(
          "expense-tracker-chat-selection:v1:demo:local",
        ),
        draftStorageKey,
      };
    },
    retainedText,
  );

  await failNextSessionStorageMutation(
    page,
    "removeItem",
    storageBeforeNew.draftStorageKey,
  );
  await page.getByTestId("chat-new").evaluate(
    (button: HTMLElement): void => button.click(),
  );
  await expect.poll(async (): Promise<boolean> =>
    page.evaluate((): boolean =>
      (window as StorageMutationTestWindow).__chatStorageMutationFailed
        === true),
  ).toBe(true);
  await expect.poll((): number => pageErrors.length).toBe(1);
  await expect(page).toHaveURL(
    (url) => url.pathname === "/chat" && !url.searchParams.has("session"),
  );
  await expect(composer).toHaveValue(retainedText);
  await expect(page.getByTestId("chat-prepared-attachment")).toContainText(
    "new-disposal-retry.txt",
  );
  expect(await page.evaluate(
    (params): Readonly<{
      activeDraft: string | null;
      selection: string | null;
      draftText: string | null;
    }> => ({
      activeDraft: window.sessionStorage.getItem(
        "expense-tracker-chat-active-draft:v1:demo:local",
      ),
      selection: window.sessionStorage.getItem(
        "expense-tracker-chat-selection:v1:demo:local",
      ),
      draftText: window.sessionStorage.getItem(params.draftStorageKey),
    }),
    storageBeforeNew,
  )).toEqual({
    activeDraft: storageBeforeNew.activeDraft,
    selection: storageBeforeNew.selection,
    draftText: retainedText,
  });

  await restoreSessionStorageMutation(page);
  await page.getByTestId("chat-new").click();
  await expect(composer).toHaveValue("");
  await expect(page.getByTestId("chat-prepared-attachment")).toHaveCount(0);
  await expect.poll(async (): Promise<string | null> =>
    page.evaluate(
      (storageKey: string): string | null =>
        window.sessionStorage.getItem(storageKey),
      storageBeforeNew.draftStorageKey,
    )).toBeNull();
  expect(await page.evaluate(
    (): string | null => window.sessionStorage.getItem(
      "expense-tracker-chat-active-draft:v1:demo:local",
    ),
  )).not.toBe(storageBeforeNew.activeDraft);
  expect(pageErrors).toHaveLength(1);
});

const pendingNewStorageFailureCases = [
  {
    name: "active draft",
    storageKey: "expense-tracker-chat-active-draft:v1:demo:local",
  },
  {
    name: "selection",
    storageKey: "expense-tracker-chat-selection:v1:demo:local",
  },
] as const;

for (const storageFailureCase of pendingNewStorageFailureCases) {
  test(`keeps a live pending draft attached when New ${storageFailureCase.name} storage fails`, async ({
    page,
    baseURL,
    context,
  }) => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }

  const createRequestReceived = createDeferred();
  const releaseCreateFailure = createDeferred();
  const pageErrors: Array<string> = [];
  page.on("pageerror", (error): void => {
    pageErrors.push(error.message);
  });
  await page.route("**/api/chat/new", async (route): Promise<void> => {
    createRequestReceived.resolve();
    await releaseCreateFailure.promise;
    await route.fulfill({
      status: 400,
      contentType: "text/plain",
      body: "Pending create rejected after New storage failure",
    });
  });

  const origin = new URL(baseURL);
  await context.addCookies([
    { name: "demo", value: "true", domain: origin.hostname, path: "/", sameSite: "Lax" },
    { name: "locale", value: "en", domain: origin.hostname, path: "/", sameSite: "Lax" },
  ]);
  await page.goto("/chat", { waitUntil: "domcontentloaded" });
  const composer = page.getByTestId("chat-composer-input");
  const submit = page.getByTestId("chat-submit");
  const submittedText = "pending draft survives failed New";
  await composer.fill(submittedText);
  await page.getByTestId("chat-file-input").setInputFiles({
    name: "pending-new-failure.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("pending New failure attachment"),
  });
  await submit.click();
  await createRequestReceived.promise;

  const activeDraftStorageKey =
    "expense-tracker-chat-active-draft:v1:demo:local";
  const selectionStorageKey =
    "expense-tracker-chat-selection:v1:demo:local";
  const storageBeforeNew = await page.evaluate(
    ({ activeKey, selectionKey }): Readonly<{
      activeDraft: string | null;
      selection: string | null;
    }> => ({
      activeDraft: window.sessionStorage.getItem(activeKey),
      selection: window.sessionStorage.getItem(selectionKey),
    }),
    {
      activeKey: activeDraftStorageKey,
      selectionKey: selectionStorageKey,
    },
  );
  await failNextSessionStorageMutation(
    page,
    "setItem",
    storageFailureCase.storageKey,
  );
  await page.getByTestId("chat-new").evaluate(
    (button: HTMLElement): void => button.click(),
  );
  await expect.poll(async (): Promise<boolean> =>
    page.evaluate((): boolean =>
      (window as StorageMutationTestWindow).__chatStorageMutationFailed
        === true),
  ).toBe(true);
  await expect.poll((): number => pageErrors.length).toBe(1);
  await expect(page).toHaveURL(
    (url) => url.pathname === "/chat"
      && !url.searchParams.has("session"),
  );
  await expect.poll(async (): Promise<Readonly<{
    activeDraft: string | null;
    selection: string | null;
  }>> => page.evaluate(
    ({ activeKey, selectionKey }): Readonly<{
      activeDraft: string | null;
      selection: string | null;
    }> => ({
      activeDraft: window.sessionStorage.getItem(activeKey),
      selection: window.sessionStorage.getItem(selectionKey),
    }),
    {
      activeKey: activeDraftStorageKey,
      selectionKey: selectionStorageKey,
    },
  )).toEqual(storageBeforeNew);
  await expect(submit).toBeDisabled();

  await restoreSessionStorageMutation(page);
  releaseCreateFailure.resolve();
  await expect(composer).toHaveValue(submittedText);
  await expect(page.getByTestId("chat-prepared-attachment")).toContainText(
    "pending-new-failure.txt",
  );
  await expect(submit).toBeEnabled();
  expect(pageErrors).toHaveLength(1);
  });
}

const detachedTerminalCases = [
  {
    kind: "rejected",
    status: 400,
    responseBody: "Detached fresh chat request rejected",
  },
  {
    kind: "unresolved",
    status: 503,
    responseBody: "Detached fresh chat request unresolved",
  },
] as const;

for (const terminalCase of detachedTerminalCases) {
  test(`disposes a detached draft after ${terminalCase.kind} create settlement`, async ({
    page,
    baseURL,
    context,
  }) => {
    if (baseURL === undefined) {
      throw new Error("Local Demo Playwright baseURL is required");
    }

    const createRequestReceived = createDeferred();
    const releaseCreateResponse = createDeferred();
    const retainedText = `retained ${terminalCase.kind} detached text`;
    let createRequestCount = 0;

    await page.route("**/api/chat/new", async (route): Promise<void> => {
      createRequestCount += 1;
      createRequestReceived.resolve();
      await releaseCreateResponse.promise;
      await route.fulfill({
        status: terminalCase.status,
        contentType: "text/plain",
        body: terminalCase.responseBody,
      });
    });

    const origin = new URL(baseURL);
    await context.addCookies([
      { name: "demo", value: "true", domain: origin.hostname, path: "/", sameSite: "Lax" },
      { name: "locale", value: "en", domain: origin.hostname, path: "/", sameSite: "Lax" },
    ]);
    await page.goto("/chat", { waitUntil: "domcontentloaded" });

    const composer = page.getByTestId("chat-composer-input");
    await expect(composer).toBeEditable();
    await composer.fill(`submitted ${terminalCase.kind} detached prompt`);
    await page.getByTestId("chat-file-input").setInputFiles({
      name: `submitted-${terminalCase.kind}.txt`,
      mimeType: "text/plain",
      buffer: Buffer.from(`submitted ${terminalCase.kind} attachment`),
    });
    await page.getByTestId("chat-submit").click();
    await createRequestReceived.promise;

    await composer.fill(retainedText);
    await page.getByTestId("chat-file-input").setInputFiles({
      name: `retained-${terminalCase.kind}.txt`,
      mimeType: "text/plain",
      buffer: Buffer.from(`retained ${terminalCase.kind} attachment`),
    });
    await expect(page.getByTestId("chat-prepared-attachment")).toContainText(
      `retained-${terminalCase.kind}.txt`,
    );
    await expect.poll(
      async (): Promise<string | null> =>
        page.evaluate(
          (expectedText: string): string | null =>
            Object.keys(window.sessionStorage).find(
              (storageKey: string): boolean =>
                storageKey.startsWith("expense-tracker-chat-draft:v2:")
                && window.sessionStorage.getItem(storageKey) === expectedText,
            ) ?? null,
          retainedText,
        ),
    ).not.toBeNull();
    const detachedDraftStorageKey = await page.evaluate(
      (expectedText: string): string | null =>
        Object.keys(window.sessionStorage).find(
          (storageKey: string): boolean =>
            storageKey.startsWith("expense-tracker-chat-draft:v2:")
            && window.sessionStorage.getItem(storageKey) === expectedText,
        ) ?? null,
      retainedText,
    );
    if (typeof detachedDraftStorageKey !== "string") {
      throw new Error(
        `Detached ${terminalCase.kind} draft storage key was not found`,
      );
    }

    await page.getByTestId("chat-new").click();
    await expect(composer).toHaveValue("");
    await expect(page.getByTestId("chat-prepared-attachment")).toHaveCount(0);
    await expect.poll(async (): Promise<string | null> =>
      page.evaluate(
        (storageKey: string): string | null =>
          window.sessionStorage.getItem(storageKey),
        detachedDraftStorageKey,
      )).toBe(retainedText);

    releaseCreateResponse.resolve();
    await expect.poll(async (): Promise<string | null> =>
      page.evaluate(
        (storageKey: string): string | null =>
          window.sessionStorage.getItem(storageKey),
        detachedDraftStorageKey,
      )).toBeNull();
    await expect(composer).toHaveValue("");
    await expect(composer).toBeEditable();
    await expect(page.getByTestId("chat-prepared-attachment")).toHaveCount(0);
    expect(createRequestCount).toBe(1);
  });
}

test("retains detached terminal state after storage failure and disposes it on New retry", async ({
  page,
  baseURL,
  context,
}) => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }

  const createRequestReceived = createDeferred();
  const releaseCreateResponse = createDeferred();
  const pageErrors: Array<string> = [];
  let createRequestCount = 0;
  page.on("pageerror", (error): void => {
    pageErrors.push(error.message);
  });
  await page.route("**/api/chat/new", async (route): Promise<void> => {
    createRequestCount += 1;
    createRequestReceived.resolve();
    await releaseCreateResponse.promise;
    await route.fulfill({
      status: 400,
      contentType: "text/plain",
      body: "Detached disposal storage failure",
    });
  });

  const origin = new URL(baseURL);
  await context.addCookies([
    { name: "demo", value: "true", domain: origin.hostname, path: "/", sameSite: "Lax" },
    { name: "locale", value: "en", domain: origin.hostname, path: "/", sameSite: "Lax" },
  ]);
  await page.goto("/chat", { waitUntil: "domcontentloaded" });

  const composer = page.getByTestId("chat-composer-input");
  const retainedText = "detached terminal disposal retry";
  await composer.fill("submitted before detached disposal failure");
  await page.getByTestId("chat-submit").click();
  await createRequestReceived.promise;
  await composer.fill(retainedText);
  await page.getByTestId("chat-file-input").setInputFiles({
    name: "detached-disposal-retry.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("detached disposal retry attachment"),
  });
  await expect(page.getByTestId("chat-prepared-attachment")).toContainText(
    "detached-disposal-retry.txt",
  );
  const detachedDraftStorageKey = await page.evaluate(
    (expectedText: string): string => {
      const storageKey = Object.keys(window.sessionStorage).find(
        (key: string): boolean =>
          key.startsWith("expense-tracker-chat-draft:v2:demo:local:")
          && window.sessionStorage.getItem(key) === expectedText,
      );
      if (storageKey === undefined) {
        throw new Error("Detached disposal retry draft storage key was not found");
      }
      return storageKey;
    },
    retainedText,
  );

  await page.getByTestId("chat-new").click();
  await expect(composer).toHaveValue("");
  await failNextSessionStorageMutation(
    page,
    "removeItem",
    detachedDraftStorageKey,
  );
  releaseCreateResponse.resolve();
  await expect.poll(async (): Promise<boolean> =>
    page.evaluate((): boolean =>
      (window as StorageMutationTestWindow).__chatStorageMutationFailed
        === true),
  ).toBe(true);
  await expect.poll((): number => pageErrors.length).toBe(1);
  expect(pageErrors[0]).toContain("Synthetic chat storage failure");
  await expect.poll(async (): Promise<string | null> =>
    page.evaluate(
      (storageKey: string): string | null =>
        window.sessionStorage.getItem(storageKey),
      detachedDraftStorageKey,
    )).toBe(retainedText);
  await expect(composer).toHaveValue("");
  await expect(page.getByTestId("chat-prepared-attachment")).toHaveCount(0);

  await restoreSessionStorageMutation(page);
  await page.getByTestId("chat-new").click();
  await expect.poll(async (): Promise<string | null> =>
    page.evaluate(
      (storageKey: string): string | null =>
        window.sessionStorage.getItem(storageKey),
      detachedDraftStorageKey,
    )).toBeNull();
  await expect(composer).toHaveValue("");
  await expect(page.getByTestId("chat-prepared-attachment")).toHaveCount(0);
  expect(createRequestCount).toBe(1);
  expect(pageErrors).toHaveLength(1);
});

test("adopts a delayed first send in the background after selecting another chat", async ({
  page,
  baseURL,
  context,
}) => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }

  const selectedSessionId = "session-selected-during-create";
  const createdSessionId = "session-created-in-background";
  const createRequestReceived = createDeferred();
  const releaseCreateResponse = createDeferred();
  const activeDraftStorageKey =
    "expense-tracker-chat-active-draft:v1:workspace:local:local";
  let createRequestCount = 0;
  let createdSessionAccepted = false;
  const oldLastMessageAt = new Date(
    Date.now() - (7 * 60 * 60 * 1000),
  ).toISOString();

  await mockWorkspaceClientDependencies(page);
  await page.route(/\/api\/chat\/sessions\?/u, async (route): Promise<void> => {
    const sessions = [{
      sessionId: selectedSessionId,
      title: "Selected while creating",
      lastMessageAt: oldLastMessageAt,
      status: "idle",
      mainContentInvalidationVersion: 0,
    }];
    if (createdSessionAccepted) {
      sessions.unshift({
        sessionId: createdSessionId,
        title: "Created in background",
        lastMessageAt: new Date().toISOString(),
        status: "running",
        mainContentInvalidationVersion: 0,
      });
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ sessions, nextCursor: null }),
    });
  });
  await page.route(
    /\/api\/chat\?sessionId=/u,
    async (route): Promise<void> => {
      const sessionId = new URL(route.request().url()).searchParams.get(
        "sessionId",
      );
      if (sessionId !== selectedSessionId && sessionId !== createdSessionId) {
        throw new Error(`Unexpected chat snapshot sessionId: ${String(sessionId)}`);
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sessionId,
          runState: sessionId === createdSessionId ? "running" : "idle",
          activeTurnId: sessionId === createdSessionId
            ? RUNNING_SNAPSHOT_TURN_ID
            : null,
          updatedAt: Date.now(),
          mainContentInvalidationVersion: 0,
          messages: [],
        }),
      });
    },
  );
  await page.route("**/api/chat/new", async (route): Promise<void> => {
    createRequestCount += 1;
    createRequestReceived.resolve();
    await releaseCreateResponse.promise;
    createdSessionAccepted = true;
    await route.fulfill({
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "X-Chat-Session-Id": createdSessionId,
      },
      body: [
        `data: {"type":"session","sessionId":"${createdSessionId}"}`,
        "data: {\"type\":\"done\"}",
        "",
      ].join("\n\n"),
    });
  });

  const origin = new URL(baseURL);
  await context.addCookies([
    { name: "locale", value: "en", domain: origin.hostname, path: "/", sameSite: "Lax" },
  ]);
  await page.goto("/chat", { waitUntil: "domcontentloaded" });
  const composer = page.getByTestId("chat-composer-input");
  await expect(composer).toBeEditable();
  await composer.fill("send before navigating");
  await page.getByTestId("chat-file-input").setInputFiles({
    name: "background.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("background attachment"),
  });
  await page.getByTestId("chat-submit").click();
  await createRequestReceived.promise;

  await page.getByTestId("chat-history-open").click();
  await page.getByTestId(`chat-history-session-${selectedSessionId}`).click();
  releaseCreateResponse.resolve();
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("session") === selectedSessionId,
  );

  await expect.poll(async (): Promise<string | null> =>
    page.evaluate(
      (storageKey: string): string | null =>
        window.sessionStorage.getItem(storageKey),
      activeDraftStorageKey,
    )).toBeNull();
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("session") === selectedSessionId,
  );
  await page.getByTestId("chat-history-open").click();
  await expect(
    page.getByTestId(`chat-history-session-${createdSessionId}`),
  ).toBeVisible();
  await page.getByTestId(`chat-history-session-${createdSessionId}`).click();
  await expect(page.getByTestId("chat-submit")).toHaveText("Stop");
  expect(createRequestCount).toBe(1);
});

test("settles the exact pending submission after a delayed A to B to A create", async ({
  page,
  baseURL,
  context,
}) => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }

  const selectedSessionId = "session-selected-between-draft-visits";
  const createdSessionId = "session-created-after-draft-revisit";
  const createRequestReceived = createDeferred();
  const releaseCreateResponse = createDeferred();
  const oldLastMessageAt = new Date(
    Date.now() - (7 * 60 * 60 * 1000),
  ).toISOString();
  let createdSessionAccepted = false;
  let createRequestCount = 0;

  await mockWorkspaceClientDependencies(page);
  await page.route(/\/api\/chat\/sessions\?/u, async (route): Promise<void> => {
    const sessions = [{
      sessionId: selectedSessionId,
      title: "Selected between draft visits",
      lastMessageAt: oldLastMessageAt,
      status: "idle",
      mainContentInvalidationVersion: 0,
    }];
    if (createdSessionAccepted) {
      sessions.unshift({
        sessionId: createdSessionId,
        title: "Created after draft revisit",
        lastMessageAt: new Date().toISOString(),
        status: "running",
        mainContentInvalidationVersion: 0,
      });
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ sessions, nextCursor: null }),
    });
  });
  await page.route(
    /\/api\/chat\?sessionId=/u,
    async (route): Promise<void> => {
      const sessionId = new URL(route.request().url()).searchParams.get(
        "sessionId",
      );
      if (sessionId !== selectedSessionId) {
        throw new Error(`Unexpected chat snapshot sessionId: ${String(sessionId)}`);
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sessionId,
          runState: "idle",
          activeTurnId: null,
          updatedAt: Date.now(),
          mainContentInvalidationVersion: 0,
          messages: [],
        }),
      });
    },
  );
  await page.route("**/api/chat/new", async (route): Promise<void> => {
    createRequestCount += 1;
    createRequestReceived.resolve();
    await releaseCreateResponse.promise;
    createdSessionAccepted = true;
    await route.fulfill({
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "X-Chat-Session-Id": createdSessionId,
      },
      body: [
        `data: {"type":"session","sessionId":"${createdSessionId}"}`,
        "data: {\"type\":\"done\"}",
        "",
      ].join("\n\n"),
    });
  });

  const origin = new URL(baseURL);
  await context.addCookies([
    { name: "locale", value: "en", domain: origin.hostname, path: "/", sameSite: "Lax" },
  ]);
  await page.goto("/chat", { waitUntil: "domcontentloaded" });

  const composer = page.getByTestId("chat-composer-input");
  const submit = page.getByTestId("chat-submit");
  await expect(composer).toBeEditable();
  await composer.fill("first submission");
  await submit.click();
  await createRequestReceived.promise;

  await page.getByTestId("chat-history-open").click();
  await page.getByTestId(`chat-history-session-${selectedSessionId}`).click();
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("session") === selectedSessionId,
  );
  await page.getByTestId("chat-new").click();
  await expect(page).toHaveURL(
    (url) => url.pathname === "/chat" && url.searchParams.get("session") === null,
  );

  await composer.fill("follow-up after returning");
  await page.getByTestId("chat-file-input").setInputFiles({
    name: "follow-up.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("follow-up attachment bytes"),
  });
  await expect(page.getByTestId("chat-prepared-attachment")).toContainText(
    "follow-up.txt",
  );
  await expect(submit).toBeDisabled();

  releaseCreateResponse.resolve();
  await expect(submit).toBeEnabled();
  await expect(composer).toHaveValue("follow-up after returning");
  await expect(page.getByTestId("chat-prepared-attachment")).toContainText(
    "follow-up.txt",
  );
  await expect(page).toHaveURL(
    (url) => url.pathname === "/chat" && url.searchParams.get("session") === null,
  );
  await page.getByTestId("chat-history-open").click();
  await expect(
    page.getByTestId(`chat-history-session-${createdSessionId}`),
  ).toBeVisible();
  expect(createRequestCount).toBe(1);
});

test("adopts a delayed first send after the sidebar remounts before the response", async ({
  page,
  baseURL,
  context,
}) => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }

  const createdSessionId = "session-created-after-unmount";
  const createRequestReceived = createDeferred();
  const releaseCreateResponse = createDeferred();
  const selectionStorageKey =
    "expense-tracker-chat-selection:v1:demo:local";
  let createRequestCount = 0;
  let createdSnapshotRequestCount = 0;

  await mockWorkspaceClientDependencies(page);
  await page.route("**/api/chat/new", async (route): Promise<void> => {
    createRequestCount += 1;
    createRequestReceived.resolve();
    await releaseCreateResponse.promise;
    await route.fulfill({
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "X-Chat-Session-Id": createdSessionId,
      },
      body: [
        `data: {"type":"session","sessionId":"${createdSessionId}"}`,
        "data: {\"type\":\"done\"}",
        "",
      ].join("\n\n"),
    });
  });
  await page.route(
    /\/api\/chat\?sessionId=/u,
    async (route): Promise<void> => {
      const sessionId = new URL(route.request().url()).searchParams.get(
        "sessionId",
      );
      if (sessionId !== createdSessionId) {
        throw new Error(`Unexpected chat snapshot sessionId: ${String(sessionId)}`);
      }
      createdSnapshotRequestCount += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sessionId: createdSessionId,
          runState: "idle",
          activeTurnId: null,
          updatedAt: Date.now(),
          mainContentInvalidationVersion: 0,
          messages: [{
            messageId: PERSISTED_SNAPSHOT_MESSAGE_ID,
            role: "assistant",
            content: [{
              type: "text",
              text: "Authoritative adopted session after remount",
            }],
            timestamp: Date.now(),
            isError: false,
            isStopped: false,
          }],
        }),
      });
    },
  );

  const origin = new URL(baseURL);
  await context.addCookies([
    { name: "demo", value: "true", domain: origin.hostname, path: "/", sameSite: "Lax" },
    { name: "locale", value: "en", domain: origin.hostname, path: "/", sameSite: "Lax" },
    { name: "chat-open", value: "true", domain: origin.hostname, path: "/", sameSite: "Lax" },
  ]);
  await page.goto("/transactions", { waitUntil: "domcontentloaded" });
  const composer = page.getByTestId("chat-composer-input");
  await expect(composer).toBeEditable();
  await composer.fill("create while sidebar closes");
  await page.getByTestId("chat-file-input").setInputFiles({
    name: "receipt.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("receipt bytes"),
  });
  await page.getByTestId("chat-submit").click();
  await createRequestReceived.promise;

  await page.getByTestId("chat-sidebar-close").click();
  await expect(page.getByTestId("chat-panel")).toHaveCount(0);
  await page.getByTestId("chat-sidebar-open").click();
  await expect(page.getByTestId("chat-panel")).toBeVisible();
  expect(createRequestCount).toBe(1);
  releaseCreateResponse.resolve();
  await expect.poll(async (): Promise<string | null> =>
    page.evaluate(
      (storageKey: string): string | null =>
        window.sessionStorage.getItem(storageKey),
      selectionStorageKey,
    )).toContain(createdSessionId);

  await expect.poll(() => createdSnapshotRequestCount).toBeGreaterThanOrEqual(1);
  await expect(page.getByTestId("chat-composer-input")).toBeEditable();
  await expect(page.getByTestId("chat-composer-input")).toHaveValue("");
  await expect(page.getByTestId("chat-prepared-attachment")).toHaveCount(0);
  await page.getByTestId("chat-new").click();
  await expect(page.getByTestId("chat-composer-input")).toHaveValue("");
  expect(createRequestCount).toBe(1);
});

test("protects a live delayed create across sidebar remount and New", async ({
  page,
  baseURL,
  context,
}) => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }

  const createdSessionId = "session-created-after-remount-new";
  const createdSessionDraftStorageKey =
    `expense-tracker-chat-draft:v2:demo:local:${
      encodeURIComponent(`session:${createdSessionId}`)
    }`;
  const createRequestReceived = createDeferred();
  const releaseCreateResponse = createDeferred();
  let createRequestCount = 0;
  let createdSessionAccepted = false;

  await mockWorkspaceClientDependencies(page);
  await page.route(/\/api\/chat\/sessions\?/u, async (route): Promise<void> => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessions: createdSessionAccepted
          ? [{
              sessionId: createdSessionId,
              title: "Created after remount and New",
              lastMessageAt: new Date().toISOString(),
              status: "idle",
              mainContentInvalidationVersion: 0,
            }]
          : [],
        nextCursor: null,
      }),
    });
  });
  await page.route(
    /\/api\/chat\?sessionId=/u,
    async (route): Promise<void> => {
      const sessionId = new URL(route.request().url()).searchParams.get(
        "sessionId",
      );
      if (sessionId !== createdSessionId) {
        throw new Error(`Unexpected chat snapshot sessionId: ${String(sessionId)}`);
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sessionId,
          runState: "idle",
          activeTurnId: null,
          updatedAt: Date.now(),
          mainContentInvalidationVersion: 0,
          messages: [],
        }),
      });
    },
  );
  await page.route("**/api/chat/new", async (route): Promise<void> => {
    createRequestCount += 1;
    createRequestReceived.resolve();
    await releaseCreateResponse.promise;
    createdSessionAccepted = true;
    await route.fulfill({
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "X-Chat-Session-Id": createdSessionId,
      },
      body: [
        `data: {"type":"session","sessionId":"${createdSessionId}"}`,
        "data: {\"type\":\"done\"}",
        "",
      ].join("\n\n"),
    });
  });

  const origin = new URL(baseURL);
  await context.addCookies([
    { name: "demo", value: "true", domain: origin.hostname, path: "/", sameSite: "Lax" },
    { name: "locale", value: "en", domain: origin.hostname, path: "/", sameSite: "Lax" },
    { name: "chat-open", value: "true", domain: origin.hostname, path: "/", sameSite: "Lax" },
  ]);
  await page.goto("/transactions", { waitUntil: "domcontentloaded" });

  const composer = page.getByTestId("chat-composer-input");
  await expect(composer).toBeEditable();
  await composer.fill("create before remount and New");
  await page.getByTestId("chat-file-input").setInputFiles({
    name: "submitted.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("submitted attachment bytes"),
  });
  await page.getByTestId("chat-submit").click();
  await createRequestReceived.promise;

  await page.getByTestId("chat-sidebar-close").click();
  await expect(page.getByTestId("chat-panel")).toHaveCount(0);
  await page.getByTestId("chat-sidebar-open").click();
  await expect(page.getByTestId("chat-panel")).toBeVisible();

  await composer.fill("retained follow-up after remount");
  await page.getByTestId("chat-file-input").setInputFiles({
    name: "retained.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("retained attachment bytes"),
  });
  await expect(page.getByTestId("chat-prepared-attachment")).toContainText(
    "retained.txt",
  );
  await page.getByTestId("chat-new").click();
  await expect(composer).toHaveValue("");
  await expect(page.getByTestId("chat-prepared-attachment")).toHaveCount(0);
  expect(createRequestCount).toBe(1);

  releaseCreateResponse.resolve();
  await expect.poll(async (): Promise<string | null> =>
    page.evaluate(
      (storageKey: string): string | null =>
        window.sessionStorage.getItem(storageKey),
      createdSessionDraftStorageKey,
    )).toBe("retained follow-up after remount");
  await getNavigationLink(page, "/chat").click();
  await expect(page).toHaveURL(
    (url) => url.pathname === "/chat"
      && url.searchParams.get("session") === null,
    { timeout: localNavigationTimeoutMs },
  );
  await expect(composer).toHaveValue("");
  await page.evaluate((sessionId: string): void => {
    window.history.pushState(
      {},
      "",
      `/chat?session=${encodeURIComponent(sessionId)}`,
    );
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, createdSessionId);
  await expect(page).toHaveURL(
    (url) => url.pathname === "/chat"
      && url.searchParams.get("session") === createdSessionId,
  );
  await expect(composer).toHaveValue("retained follow-up after remount");
  await expect(page.getByTestId("chat-prepared-attachment")).toContainText(
    "retained.txt",
  );
  await expect(page.getByTestId("chat-submit")).toBeEnabled();
  expect(createRequestCount).toBe(1);
});

test("fences a delayed create after the provider scope changes", async ({
  page,
  baseURL,
  context,
}) => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }

  const staleSessionId = "session-from-stale-workspace-scope";
  const createRequestReceived = createDeferred();
  const releaseCreateResponse = createDeferred();
  let unexpectedSnapshotCount = 0;

  await page.exposeFunction(
    "__releaseChatCreateAtLayoutCommit",
    (): void => releaseCreateResponse.resolve(),
  );
  await page.addInitScript((): void => {
    const originalAbort = AbortController.prototype.abort;
    AbortController.prototype.abort = function abort(
      reason?: unknown,
    ): void {
      const testWindow = window as LayoutCleanupTestWindow;
      if (testWindow.__chatCreateReleasedAtLayoutCommit === true) {
        Object.defineProperty(
          testWindow,
          "__chatAbortAfterCreateReleaseCount",
          {
            configurable: true,
            value: (testWindow.__chatAbortAfterCreateReleaseCount ?? 0) + 1,
          },
        );
      }
      originalAbort.call(this, reason);
    };
    const observeDemoCommit = (): void => {
      let didRelease = false;
      const releaseWhenDemoIsCommitted = (): void => {
        const demoButton = document.querySelector(
          '[data-testid="mode-demo"][aria-pressed="true"]',
        );
        if (didRelease || demoButton === null) {
          return;
        }
        const testWindow = window as LayoutCleanupTestWindow;
        const composer = document.querySelector(
          '[data-testid="chat-composer-input"]',
        );
        const chatPanel = document.querySelector('[data-testid="chat-panel"]');
        const renderedPreviousScope =
          composer instanceof HTMLTextAreaElement
          && composer.value === "pending in the original workspace scope"
          || chatPanel?.textContent?.includes(
            "pending in the original workspace scope",
          ) === true;
        Object.defineProperty(
          testWindow,
          "__chatPreviousScopeRenderedAfterCommit",
          {
            configurable: true,
            value: renderedPreviousScope,
          },
        );
        const releaseCreate = testWindow.__releaseChatCreateAtLayoutCommit;
        if (releaseCreate === undefined) {
          throw new Error(
            "Layout cleanup create-response resolver is missing",
          );
        }
        didRelease = true;
        Object.defineProperty(
          testWindow,
          "__chatCreateReleasedAtLayoutCommit",
          {
            configurable: true,
            value: true,
          },
        );
        void releaseCreate();
      };
      const observer = new MutationObserver(releaseWhenDemoIsCommitted);
      observer.observe(document.documentElement, {
        attributes: true,
        childList: true,
        subtree: true,
        attributeFilter: ["aria-pressed"],
      });
      releaseWhenDemoIsCommitted();
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", observeDemoCommit, {
        once: true,
      });
    } else {
      observeDemoCommit();
    }
  });

  await mockWorkspaceClientDependencies(page);
  await page.route(/\/api\/chat\/sessions\?/u, async (route): Promise<void> => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessions: [],
        nextCursor: null,
      }),
    });
  });
  await page.route(
    /\/api\/chat\?sessionId=/u,
    async (route): Promise<void> => {
      unexpectedSnapshotCount += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sessionId: staleSessionId,
          runState: "idle",
          activeTurnId: null,
          updatedAt: Date.now(),
          mainContentInvalidationVersion: 0,
          messages: [],
        }),
      });
    },
  );
  await page.route("**/api/chat/new", async (route): Promise<void> => {
    createRequestReceived.resolve();
    await releaseCreateResponse.promise;
    await route.fulfill({
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "X-Chat-Session-Id": staleSessionId,
      },
      body: [
        `data: {"type":"session","sessionId":"${staleSessionId}"}`,
        "data: {\"type\":\"done\"}",
        "",
      ].join("\n\n"),
    });
  });

  const origin = new URL(baseURL);
  await context.addCookies([
    { name: "locale", value: "en", domain: origin.hostname, path: "/", sameSite: "Lax" },
    { name: "chat-open", value: "true", domain: origin.hostname, path: "/", sameSite: "Lax" },
  ]);
  await page.goto("/chat", { waitUntil: "domcontentloaded" });
  const composer = page.getByTestId("chat-composer-input");
  await expect(composer).toBeEditable();
  await composer.fill("pending in the original workspace scope");
  await page.getByTestId("chat-submit").click();
  await createRequestReceived.promise;

  await page.evaluate((): void => {
    document.cookie = "demo=true; path=/; max-age=31536000";
    const channel = new BroadcastChannel(
      "expense-tracker-main-content-invalidation",
    );
    channel.postMessage({
      type: "main_content_invalidation",
      workspaceId: "local",
      version: 1,
      sourceId: "scope-change-test",
      emittedAt: Date.now(),
    });
    channel.close();
  });
  await expect(page.getByTestId("mode-demo")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByTestId("chat-panel")).toBeVisible();
  await expect(composer).toBeEditable();
  await expect(composer).toHaveValue("");
  await composer.fill("new demo scope remains selected");
  await page.evaluate((): void => {
    window.localStorage.removeItem(
      "expense-tracker-main-content-invalidation",
    );
  });

  await expect.poll(async (): Promise<boolean> =>
    page.evaluate((): boolean =>
      (window as LayoutCleanupTestWindow)
        .__chatCreateReleasedAtLayoutCommit === true)).toBe(true);
  await expect.poll(async (): Promise<boolean | undefined> =>
    page.evaluate((): boolean | undefined =>
      (window as LayoutCleanupTestWindow)
        .__chatPreviousScopeRenderedAfterCommit)).toBe(false);
  await expect.poll(async (): Promise<number> =>
    page.evaluate((): number =>
      (window as LayoutCleanupTestWindow)
        .__chatAbortAfterCreateReleaseCount ?? 0)).toBeGreaterThan(0);

  await expect(composer).toHaveValue("new demo scope remains selected");
  await expect(page.getByTestId("chat-prepared-attachment")).toHaveCount(0);
  await page.getByTestId("chat-history-open").click();
  await expect(
    page.getByTestId(`chat-history-session-${staleSessionId}`),
  ).toHaveCount(0);
  await expect(page.getByTestId("chat-history-empty")).toBeVisible();
  await page.getByTestId("chat-history-close").click();
  await expect.poll(async (): Promise<string | null> =>
    page.evaluate(
      (): string | null => window.localStorage.getItem(
        "expense-tracker-main-content-invalidation",
      ),
    )).toBeNull();
  const demoSelection = await page.evaluate(
    (): string | null => window.sessionStorage.getItem(
      "expense-tracker-chat-selection:v1:demo:local",
    ),
  );
  expect(demoSelection).not.toContain(staleSessionId);
  expect(unexpectedSnapshotCount).toBe(0);

  await getNavigationLink(page, "/transactions").click();
  await expect(page).toHaveURL(
    (url) => url.pathname === "/transactions",
    { timeout: localNavigationTimeoutMs },
  );
  await expect(page.getByTestId("chat-panel")).toBeVisible();
  await page.getByTestId("chat-sidebar-close").click();
  await expect(page.getByTestId("chat-panel")).toHaveCount(0);
  await page.getByTestId("chat-sidebar-open").click();
  await expect(composer).toHaveValue("new demo scope remains selected");
});

test("fences delayed controller catalog work after the provider scope changes", async ({
  page,
  baseURL,
  context,
}) => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }

  const workspaceSessionId = "session-old-scope-controller";
  const reconciliationSnapshotReceived = createDeferred();
  const releaseReconciliationSnapshot = createDeferred();
  const reconciliationRequestTerminated = createDeferred();
  const lastMessageAt = new Date().toISOString();
  let catalogRequestCount = 0;
  let snapshotRequestCount = 0;
  let snapshotRequestTerminalCount = 0;
  const markReleasedReconciliationRequestTerminated = (
    requestUrl: string,
    requestMethod: string,
  ): void => {
    if (
      requestMethod === "GET"
      && requestUrl.includes(
        `/api/chat?sessionId=${workspaceSessionId}`,
      )
    ) {
      snapshotRequestTerminalCount += 1;
      if (snapshotRequestTerminalCount === 2) {
        reconciliationRequestTerminated.resolve();
      }
    }
  };
  page.on("requestfinished", (request): void => {
    markReleasedReconciliationRequestTerminated(
      request.url(),
      request.method(),
    );
  });
  page.on("requestfailed", (request): void => {
    markReleasedReconciliationRequestTerminated(
      request.url(),
      request.method(),
    );
  });

  await page.addInitScript((sessionId: string): void => {
    const observeDemoCommit = (): void => {
      const observer = new MutationObserver((): void => {
        const demoButton = document.querySelector(
          '[data-testid="mode-demo"][aria-pressed="true"]',
        );
        if (demoButton === null) {
          return;
        }
        const previousValue = (window as LayoutCleanupTestWindow)
          .__chatPreviousCatalogRenderedAfterCommit === true;
        const renderedPreviousCatalog = document.querySelector(
          `[data-testid="chat-history-session-${sessionId}"]`,
        ) !== null;
        Object.defineProperty(
          window,
          "__chatPreviousCatalogRenderedAfterCommit",
          {
            configurable: true,
            value: previousValue || renderedPreviousCatalog,
          },
        );
      });
      observer.observe(document.documentElement, {
        attributes: true,
        childList: true,
        subtree: true,
        attributeFilter: ["aria-pressed"],
      });
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", observeDemoCommit, {
        once: true,
      });
    } else {
      observeDemoCommit();
    }
  }, workspaceSessionId);
  await mockWorkspaceClientDependencies(page);
  await page.route(/\/api\/chat\/sessions\?/u, async (route): Promise<void> => {
    catalogRequestCount += 1;
    const isDemoRequest = route.request().headers()["cookie"]
      ?.split(";")
      .some((value): boolean => value.trim() === "demo=true") === true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessions: isDemoRequest
          ? []
          : [{
              sessionId: workspaceSessionId,
              title: workspaceSessionId,
              lastMessageAt,
              status: "idle",
              mainContentInvalidationVersion: 0,
            }],
        nextCursor: null,
      }),
    });
  });
  await page.route(
    /\/api\/chat\?sessionId=/u,
    async (route): Promise<void> => {
      const requestUrl = new URL(route.request().url());
      const sessionId = requestUrl.searchParams.get("sessionId");
      if (sessionId !== workspaceSessionId) {
        throw new Error(
          `Unexpected old-scope chat session: ${String(sessionId)}`,
        );
      }
      if (route.request().method() === "POST") {
        await route.fulfill({
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
          },
          body: [
            "data: {\"type\":\"done\"}",
            "",
          ].join("\n\n"),
        });
        return;
      }

      snapshotRequestCount += 1;
      if (snapshotRequestCount === 2) {
        reconciliationSnapshotReceived.resolve();
        await releaseReconciliationSnapshot.promise;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sessionId,
          runState: "idle",
          activeTurnId: null,
          updatedAt: Date.now(),
          mainContentInvalidationVersion: 0,
          messages: [],
        }),
      });
    },
  );

  const origin = new URL(baseURL);
  await context.addCookies([
    { name: "locale", value: "en", domain: origin.hostname, path: "/", sameSite: "Lax" },
    { name: "chat-open", value: "true", domain: origin.hostname, path: "/", sameSite: "Lax" },
  ]);
  await page.goto(`/chat?session=${workspaceSessionId}`, {
    waitUntil: "domcontentloaded",
  });
  const composer = page.getByTestId("chat-composer-input");
  await expect(composer).toBeEditable();
  await composer.fill("send before changing provider scope");
  await page.getByTestId("chat-submit").click();
  await reconciliationSnapshotReceived.promise;
  expect(catalogRequestCount).toBe(1);
  await page.getByTestId("chat-history-open").click();
  await expect(
    page.getByTestId(`chat-history-session-${workspaceSessionId}`),
  ).toBeVisible();

  await page.evaluate((): void => {
    document.cookie = "demo=true; path=/; max-age=31536000";
    const channel = new BroadcastChannel(
      "expense-tracker-main-content-invalidation",
    );
    channel.postMessage({
      type: "main_content_invalidation",
      workspaceId: "local",
      version: 2,
      sourceId: "controller-scope-change-test",
      emittedAt: Date.now(),
    });
    channel.close();
  });
  await expect(page.getByTestId("mode-demo")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect.poll(async (): Promise<boolean | undefined> =>
    page.evaluate((): boolean | undefined =>
      (window as LayoutCleanupTestWindow)
        .__chatPreviousCatalogRenderedAfterCommit)).toBe(false);
  await expect(composer).toBeEditable();
  await composer.fill("demo scope remains authoritative");

  await reconciliationRequestTerminated.promise;
  releaseReconciliationSnapshot.resolve();
  expect(catalogRequestCount).toBe(2);
  await expect(composer).toHaveValue("demo scope remains authoritative");
  await page.getByTestId("chat-history-open").click();
  await expect(
    page.getByTestId(`chat-history-session-${workspaceSessionId}`),
  ).toHaveCount(0);
  await expect(page.getByTestId("chat-history-empty")).toBeVisible();
});

test("keeps the newest session popstate during a slow catalog bootstrap", async ({
  page,
  baseURL,
  context,
}) => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }

  const sessionA = "session-bootstrap-a";
  const sessionB = "session-bootstrap-b";
  const bootstrap = await mockDelayedChatBootstrap(
    page,
    [sessionA, sessionB],
  );
  const origin = new URL(baseURL);
  await context.addCookies([
    { name: "locale", value: "en", domain: origin.hostname, path: "/", sameSite: "Lax" },
  ]);

  await page.goto(`/chat?session=${sessionA}`, {
    waitUntil: "domcontentloaded",
  });
  await bootstrap.catalogRequestReceived;
  await page.evaluate((nextSessionId: string): void => {
    window.history.pushState(
      window.history.state,
      "",
      `/chat?session=${encodeURIComponent(nextSessionId)}`,
    );
    window.history.back();
  }, sessionB);
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("session") === sessionA,
  );
  await page.evaluate((): void => window.history.forward());
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("session") === sessionB,
  );

  bootstrap.releaseCatalog();
  await expect(page.getByTestId("chat-composer-input")).toBeEditable();
  await expect.poll(
    (): Array<string> => [...bootstrap.snapshotSessionIds],
  ).toEqual([sessionB]);
  await expect(page).toHaveURL(
    (url) => url.pathname === "/chat"
      && url.searchParams.get("session") === sessionB,
  );
});

test("keeps a newer draft popstate over an older bootstrap session", async ({
  page,
  baseURL,
  context,
}) => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }

  const sessionId = "session-bootstrap-draft";
  const selectionStorageKey =
    "expense-tracker-chat-selection:v1:workspace:local:local";
  const bootstrap = await mockDelayedChatBootstrap(page, [sessionId]);
  const origin = new URL(baseURL);
  await context.addCookies([
    { name: "locale", value: "en", domain: origin.hostname, path: "/", sameSite: "Lax" },
  ]);

  await page.goto(`/chat?session=${sessionId}`, {
    waitUntil: "domcontentloaded",
  });
  await bootstrap.catalogRequestReceived;
  await page.evaluate((): void => {
    window.history.pushState(window.history.state, "", "/chat");
    window.history.back();
  });
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("session") === sessionId,
  );
  await page.evaluate((): void => window.history.forward());
  await expect(page).toHaveURL(
    (url) => url.pathname === "/chat" && !url.searchParams.has("session"),
  );

  bootstrap.releaseCatalog();
  await expect(page.getByTestId("chat-composer-input")).toBeEditable();
  await expect.poll(
    (): Array<string> => [...bootstrap.snapshotSessionIds],
  ).toEqual([]);
  const storedTarget = await page.evaluate(
    (storageKey: string): string | null =>
      window.sessionStorage.getItem(storageKey),
    selectionStorageKey,
  );
  expect(storedTarget).toMatch(/"kind":"draft"/u);
  await expect(page).toHaveURL(
    (url) => url.pathname === "/chat" && !url.searchParams.has("session"),
  );
});

test("loads additional history pages without overlap and preserves rows on retry", async ({
  page,
  baseURL,
  context,
}) => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }

  const nextCursor = "cursor-1";
  const nextPageRequestReceived = createDeferred();
  const releaseNextPageFailure = createDeferred();
  let nextPageRequestCount = 0;
  const lastMessageAt = new Date(
    Date.now() - (7 * 60 * 60 * 1000),
  ).toISOString();
  const createSummary = (
    sessionId: string,
    title: string,
  ): Readonly<{
    sessionId: string;
    title: string;
    lastMessageAt: string;
    status: "idle";
    mainContentInvalidationVersion: number;
  }> => ({
    sessionId,
    title,
    lastMessageAt,
    status: "idle",
    mainContentInvalidationVersion: 0,
  });

  await mockWorkspaceClientDependencies(page);
  await page.route(/\/api\/chat\/sessions\?/u, async (route): Promise<void> => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    if (cursor === null) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sessions: [
            createSummary("session-page-1", "First page"),
            createSummary("session-deduped", "Original title"),
          ],
          nextCursor,
        }),
      });
      return;
    }
    if (cursor !== nextCursor) {
      throw new Error(`Unexpected chat catalog cursor: ${cursor}`);
    }

    nextPageRequestCount += 1;
    if (nextPageRequestCount === 1) {
      nextPageRequestReceived.resolve();
      await releaseNextPageFailure.promise;
      await route.fulfill({
        status: 503,
        contentType: "text/plain",
        body: "Catalog page unavailable",
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessions: [
          createSummary("session-deduped", "Updated title"),
          createSummary("session-page-2", "Second page"),
        ],
        nextCursor: null,
      }),
    });
  });

  const origin = new URL(baseURL);
  await context.addCookies([
    { name: "locale", value: "en", domain: origin.hostname, path: "/", sameSite: "Lax" },
  ]);
  await page.goto("/chat", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("chat-composer-input")).toBeEditable();
  await page.getByTestId("chat-history-open").click();
  const loadMore = page.getByTestId("chat-history-load-more");
  await expect(loadMore).toBeEnabled();
  await loadMore.click();
  await nextPageRequestReceived.promise;
  await expect(loadMore).toBeDisabled();
  await loadMore.evaluate((button: HTMLElement): void => button.click());
  expect(nextPageRequestCount).toBe(1);

  releaseNextPageFailure.resolve();
  await expect(page.getByTestId("chat-history-error")).toBeVisible();
  await expect(page.getByTestId("chat-history-session-session-page-1")).toBeVisible();
  await expect(page.getByTestId("chat-history-session-session-deduped")).toBeVisible();
  await expect(loadMore).toBeEnabled();

  await loadMore.click();
  await expect(page.getByTestId("chat-history-session-session-page-2")).toBeVisible();
  await expect(
    page.getByTestId("chat-history-session-session-deduped"),
  ).toHaveCount(1);
  await expect(
    page.getByTestId("chat-history-session-session-deduped"),
  ).toContainText("Updated title");
  await expect(loadMore).toHaveCount(0);
  expect(nextPageRequestCount).toBe(2);
});

test("repairs an unavailable sidebar history selection outside fullscreen chat", async ({
  page,
  baseURL,
  context,
}) => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }

  const safeSessionId = "session-safe";
  const missingSessionId = "session-missing";
  const secondMissingSessionId = "session-missing-second";
  const selectionStorageKey =
    "expense-tracker-chat-selection:v1:workspace:local:local";
  const lastMessageAt = new Date().toISOString();
  let safeSnapshotRequestCount = 0;
  let missingSnapshotRequestCount = 0;
  let secondMissingSnapshotRequestCount = 0;
  let hasObservedMissingSnapshot = false;

  await page.addInitScript((params: Readonly<{
    storageKey: string;
    sessionId: string;
  }>): void => {
    const initializationMarker = `${params.storageKey}:initialized`;
    if (window.sessionStorage.getItem(initializationMarker) !== null) {
      return;
    }
    window.sessionStorage.setItem(initializationMarker, "true");
    window.sessionStorage.setItem(params.storageKey, JSON.stringify({
      kind: "session",
      sessionId: params.sessionId,
    }));
  }, {
    storageKey: selectionStorageKey,
    sessionId: safeSessionId,
  });

  await page.route(/\/api\/chat\/sessions\?/u, async (route): Promise<void> => {
    const sessions = hasObservedMissingSnapshot
      ? [
        {
          sessionId: safeSessionId,
          title: "Safe session",
          lastMessageAt,
          status: "idle",
          mainContentInvalidationVersion: 0,
        },
      ]
      : [
        {
          sessionId: secondMissingSessionId,
          title: "Second unavailable session",
          lastMessageAt,
          status: "running",
          mainContentInvalidationVersion: 0,
        },
        {
          sessionId: missingSessionId,
          title: "Unavailable session",
          lastMessageAt,
          status: "running",
          mainContentInvalidationVersion: 0,
        },
        {
          sessionId: safeSessionId,
          title: "Safe session",
          lastMessageAt,
          status: "idle",
          mainContentInvalidationVersion: 0,
        },
      ];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessions,
        nextCursor: null,
      }),
    });
  });
  await page.route(
    /\/api\/chat\?sessionId=/u,
    async (route): Promise<void> => {
      const sessionId = new URL(route.request().url()).searchParams.get(
        "sessionId",
      );
      if (sessionId === missingSessionId) {
        missingSnapshotRequestCount += 1;
        hasObservedMissingSnapshot = true;
        await route.fulfill({
          status: 404,
          contentType: "text/plain",
          body: `Chat session not found: ${missingSessionId}`,
        });
        return;
      }
      if (sessionId === secondMissingSessionId) {
        secondMissingSnapshotRequestCount += 1;
        await route.fulfill({
          status: 404,
          contentType: "text/plain",
          body: `Chat session not found: ${secondMissingSessionId}`,
        });
        return;
      }
      if (sessionId !== safeSessionId) {
        throw new Error(`Unexpected chat snapshot sessionId: ${String(sessionId)}`);
      }

      safeSnapshotRequestCount += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sessionId: safeSessionId,
          runState: "idle",
          activeTurnId: null,
          updatedAt: Date.now(),
          mainContentInvalidationVersion: 0,
          messages: [],
        }),
      });
    },
  );
  await page.route(
    "**/api/account-suggestions",
    async (route): Promise<void> => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "[]",
      });
    },
  );
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

  const origin = new URL(baseURL);
  await context.addCookies([
    { name: "locale", value: "en", domain: origin.hostname, path: "/", sameSite: "Lax" },
    { name: "chat-open", value: "true", domain: origin.hostname, path: "/", sameSite: "Lax" },
  ]);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("chat-composer-input")).toBeEditable();
  await expect.poll(() => safeSnapshotRequestCount).toBe(1);

  await page.getByTestId("chat-history-open").click();
  await page.getByTestId(`chat-history-session-${missingSessionId}`).click();

  await expect.poll(() => missingSnapshotRequestCount).toBe(1);
  await expect.poll(() => secondMissingSnapshotRequestCount).toBe(1);
  await expect.poll(() => safeSnapshotRequestCount).toBeGreaterThanOrEqual(2);
  await expect(page).toHaveURL(
    (url) => url.pathname === "/" && url.search === "",
  );
  expect(await page.evaluate(
    (storageKey: string): string | null =>
      window.sessionStorage.getItem(storageKey),
    selectionStorageKey,
  )).toBeNull();

  await page.getByTestId("chat-history-open").click();
  await expect(
    page.getByTestId(`chat-history-session-${safeSessionId}`),
  ).toHaveAttribute("aria-current", "true");
  await page.getByTestId("chat-history-close").click();

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("chat-composer-input")).toBeEditable();
  await expect.poll(() => safeSnapshotRequestCount).toBeGreaterThanOrEqual(3);
  expect(missingSnapshotRequestCount).toBe(1);
  expect(secondMissingSnapshotRequestCount).toBe(1);
  expect(await page.evaluate(
    (storageKey: string): string | null =>
      window.sessionStorage.getItem(storageKey),
    selectionStorageKey,
  )).toBeNull();
});

test("switches between running sessions without aborting bootstrap or leaking Stop state", async ({
  page,
  baseURL,
  context,
}) => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }

  const sessionA = "session-running-a";
  const sessionB = "session-running-b";
  const bSnapshotRequestReceived = createDeferred();
  const releaseFirstBSnapshot = createDeferred();
  const stopRequestReceived = createDeferred();
  const releaseStopResponse = createDeferred();
  const snapshotRequestCounts = new Map<string, number>();
  const stoppedSessionIds: Array<string> = [];
  const lastMessageAt = new Date().toISOString();
  let chatSendRequestCount = 0;

  await page.addInitScript((): void => {
    const originalFetch = window.fetch.bind(window);
    const markStopContinuationTerminal = (): void => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (): void => {
        const testWindow = window as StopContinuationTestWindow;
        const currentCount =
          testWindow.__chatStopResponseTerminalCount ?? 0;
        Object.defineProperty(
          testWindow,
          "__chatStopResponseTerminalCount",
          {
            configurable: true,
            value: currentCount + 1,
          },
        );
        channel.port1.close();
        channel.port2.close();
      };
      channel.port2.postMessage(null);
    };
    window.fetch = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const requestUrl = input instanceof Request
        ? input.url
        : String(input);
      if (new URL(requestUrl, window.location.href).pathname !== "/api/chat/stop") {
        return originalFetch(input, init);
      }
      let response: Response;
      try {
        response = await originalFetch(input, init);
      } catch (error) {
        markStopContinuationTerminal();
        throw error;
      }
      const originalText = response.text.bind(response);
      Object.defineProperty(response, "text", {
        configurable: true,
        value: async (): Promise<string> => {
          const text = await originalText();
          markStopContinuationTerminal();
          return text;
        },
      });
      return response;
    };
  });
  await mockWorkspaceClientDependencies(page);
  page.on("request", (request): void => {
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname === "/api/chat") {
      chatSendRequestCount += 1;
    }
  });
  await page.route(/\/api\/chat\/sessions\?/u, async (route): Promise<void> => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessions: [sessionA, sessionB].map((sessionId) => ({
          sessionId,
          title: sessionId,
          lastMessageAt,
          status: "running",
          mainContentInvalidationVersion: 0,
        })),
        nextCursor: null,
      }),
    });
  });
  await page.route(
    /\/api\/chat\?sessionId=/u,
    async (route): Promise<void> => {
      const sessionId = new URL(route.request().url()).searchParams.get(
        "sessionId",
      );
      if (sessionId !== sessionA && sessionId !== sessionB) {
        throw new Error(`Unexpected chat snapshot sessionId: ${String(sessionId)}`);
      }

      const requestCount = (snapshotRequestCounts.get(sessionId) ?? 0) + 1;
      snapshotRequestCounts.set(sessionId, requestCount);
      if (sessionId === sessionB && requestCount === 1) {
        bSnapshotRequestReceived.resolve();
        await releaseFirstBSnapshot.promise;
      }
      const runState = "running";
      const activeTurnId = sessionId === sessionB
          ? SECOND_RUNNING_SNAPSHOT_TURN_ID
          : requestCount === 1
            ? RUNNING_SNAPSHOT_TURN_ID
            : NEWER_RUNNING_SNAPSHOT_TURN_ID;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sessionId,
          runState,
          activeTurnId,
          updatedAt: Date.now(),
          mainContentInvalidationVersion: 0,
          messages: [],
        }),
      });
    },
  );
  await page.route("**/api/chat/stop", async (route): Promise<void> => {
    const body = route.request().postDataJSON() as Readonly<{
      sessionId: string;
    }>;
    stoppedSessionIds.push(body.sessionId);
    stopRequestReceived.resolve();
    await releaseStopResponse.promise;
    await route.fulfill({
      status: 503,
      contentType: "text/plain",
      body: "Stop request failed",
    });
  });

  const origin = new URL(baseURL);
  await context.addCookies([
    { name: "locale", value: "en", domain: origin.hostname, path: "/", sameSite: "Lax" },
  ]);
  await page.goto("/chat", { waitUntil: "domcontentloaded" });
  await expect.poll(() => snapshotRequestCounts.get(sessionA) ?? 0).toBe(1);
  await expect(page.getByTestId("chat-submit")).toBeEnabled();
  await expect(page.getByTestId("chat-submit")).toHaveText("Stop");

  await page.getByTestId("chat-submit").click();
  await stopRequestReceived.promise;
  await page.getByTestId("chat-history-open").click();
  await page.getByTestId(`chat-history-session-${sessionB}`).click();
  await bSnapshotRequestReceived.promise;
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("session") === sessionB,
  );
  releaseFirstBSnapshot.resolve();
  await expect(page.getByTestId("chat-submit")).toBeEnabled();
  await expect(page.getByTestId("chat-submit")).toHaveText("Stop");

  await page.getByTestId("chat-history-open").click();
  await page.getByTestId(`chat-history-session-${sessionA}`).click();
  await expect.poll(() => snapshotRequestCounts.get(sessionA) ?? 0).toBe(2);
  const submitButton = page.getByTestId("chat-submit");
  await expect(submitButton).toBeEnabled();
  await expect(submitButton).toHaveText("Stop");
  expect(chatSendRequestCount).toBe(0);

  releaseStopResponse.resolve();
  await expect.poll(async (): Promise<number | undefined> =>
    page.evaluate((): number | undefined =>
      (window as StopContinuationTestWindow)
        .__chatStopResponseTerminalCount)).toBe(1);
  expect(snapshotRequestCounts.get(sessionA)).toBe(2);
  await expect(page.getByTestId("chat-submit")).toBeEnabled();
  await expect(page.getByTestId("chat-submit")).toHaveText("Stop");

  await page.getByTestId("chat-history-open").click();
  await page.getByTestId(`chat-history-session-${sessionB}`).click();
  await expect.poll(() => snapshotRequestCounts.get(sessionB) ?? 0).toBe(2);
  await expect(page.getByTestId("chat-submit")).toBeEnabled();
  await expect(page.getByTestId("chat-submit")).toHaveText("Stop");
  expect(stoppedSessionIds).toEqual([sessionA]);
});

test("migrates the legacy scope draft only after the real local target is ready", async ({
  page,
  baseURL,
  context,
}) => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }

  const legacyStorageKey = "expense-tracker-chat-draft:v1:demo:local";
  await page.addInitScript((storageKey: string): void => {
    window.sessionStorage.setItem(storageKey, "legacy draft text");
  }, legacyStorageKey);
  const origin = new URL(baseURL);
  await context.addCookies([
    { name: "demo", value: "true", domain: origin.hostname, path: "/", sameSite: "Lax" },
    { name: "locale", value: "en", domain: origin.hostname, path: "/", sameSite: "Lax" },
    { name: "chat-open", value: "true", domain: origin.hostname, path: "/", sameSite: "Lax" },
  ]);

  await page.goto("/transactions", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("chat-composer-input")).toHaveValue(
    "legacy draft text",
  );
  const storedDrafts = await page.evaluate((storageKey: string): Readonly<{
    legacyValue: string | null;
    currentValues: ReadonlyArray<string | null>;
  }> => ({
    legacyValue: window.sessionStorage.getItem(storageKey),
    currentValues: Array.from(
      { length: window.sessionStorage.length },
      (_value: undefined, index: number): string | null =>
        window.sessionStorage.key(index),
    )
      .filter(
        (key: string | null): key is string =>
          key?.startsWith("expense-tracker-chat-draft:v2:demo:local:") ?? false,
      )
      .map((key: string): string | null => window.sessionStorage.getItem(key)),
  }), legacyStorageKey);

  expect(storedDrafts.legacyValue).toBeNull();
  expect(storedDrafts.currentValues).toEqual(["legacy draft text"]);
});

type AdoptionStorageFailureCase = Readonly<{
  slug: string;
  name: string;
  method: "setItem" | "removeItem";
  getStorageKey: (
    sourceStorageKey: string,
    sessionId: string,
  ) => string;
}>;

const adoptionStorageFailureCases: ReadonlyArray<
  AdoptionStorageFailureCase
> = [
  {
    slug: "destination",
    name: "destination draft write",
    method: "setItem",
    getStorageKey: (
      _sourceStorageKey: string,
      sessionId: string,
    ): string =>
      `expense-tracker-chat-draft:v2:workspace:local:local:${
        encodeURIComponent(`session:${sessionId}`)
      }`,
  },
  {
    slug: "source",
    name: "source draft clear",
    method: "removeItem",
    getStorageKey: (
      sourceStorageKey: string,
      _sessionId: string,
    ): string => sourceStorageKey,
  },
  {
    slug: "active",
    name: "active draft clear",
    method: "removeItem",
    getStorageKey: (
      _sourceStorageKey: string,
      _sessionId: string,
    ): string =>
      "expense-tracker-chat-active-draft:v1:workspace:local:local",
  },
  {
    slug: "selection",
    name: "explicit session selection write",
    method: "setItem",
    getStorageKey: (
      _sourceStorageKey: string,
      _sessionId: string,
    ): string =>
      "expense-tracker-chat-selection:v1:workspace:local:local",
  },
];

for (const failureCase of adoptionStorageFailureCases) {
  test(`rolls back ${failureCase.name} failure during draft adoption`, async ({
    page,
    baseURL,
    context,
  }) => {
    if (baseURL === undefined) {
      throw new Error("Local Demo Playwright baseURL is required");
    }

    const sessionId = `session-storage-failure-${failureCase.slug}`;
    const createRequestReceived = createDeferred();
    const releaseCreateResponse = createDeferred();
    let snapshotRequestCount = 0;

    await mockWorkspaceClientDependencies(page);
    await page.route(/\/api\/chat\/sessions\?/u, async (route): Promise<void> => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sessions: [],
          nextCursor: null,
        }),
      });
    });
    await page.route(
      /\/api\/chat\?sessionId=/u,
      async (route): Promise<void> => {
        snapshotRequestCount += 1;
        await route.fulfill({
          status: 500,
          contentType: "text/plain",
          body: "Adoption failure must not request a session snapshot",
        });
      },
    );
    await page.route("**/api/chat/new", async (route): Promise<void> => {
      createRequestReceived.resolve();
      await releaseCreateResponse.promise;
      await route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "X-Chat-Session-Id": sessionId,
        },
        body: [
          `data: {"type":"session","sessionId":"${sessionId}"}`,
          "data: {\"type\":\"done\"}",
          "",
        ].join("\n\n"),
      });
    });

    const origin = new URL(baseURL);
    await context.addCookies([
      {
        name: "locale",
        value: "en",
        domain: origin.hostname,
        path: "/",
        sameSite: "Lax",
      },
    ]);
    await page.goto("/chat", { waitUntil: "domcontentloaded" });
    const composer = page.getByTestId("chat-composer-input");
    await expect(composer).toBeEditable();
    await composer.fill(`submitted before ${failureCase.name}`);
    await page.getByTestId("chat-submit").click();
    await createRequestReceived.promise;

    const retainedText = `retained after ${failureCase.name}`;
    const retainedAttachmentName = `retained-${failureCase.slug}.txt`;
    await composer.fill(retainedText);
    await page.getByTestId("chat-file-input").setInputFiles({
      name: retainedAttachmentName,
      mimeType: "text/plain",
      buffer: Buffer.from(`attachment retained after ${failureCase.name}`),
    });
    await expect(page.getByTestId("chat-prepared-attachment")).toContainText(
      retainedAttachmentName,
    );

    const storageBeforeAdoption = await page.evaluate(
      (expectedText: string): Readonly<{
        sourceStorageKey: string;
        sourceText: string | null;
        activeDraft: string | null;
        selection: string | null;
      }> => {
        for (
          let index = 0;
          index < window.sessionStorage.length;
          index += 1
        ) {
          const storageKey = window.sessionStorage.key(index);
          if (
            storageKey?.startsWith(
              "expense-tracker-chat-draft:v2:workspace:local:local:",
            ) === true
            && window.sessionStorage.getItem(storageKey) === expectedText
          ) {
            return {
              sourceStorageKey: storageKey,
              sourceText: window.sessionStorage.getItem(storageKey),
              activeDraft: window.sessionStorage.getItem(
                "expense-tracker-chat-active-draft:v1:workspace:local:local",
              ),
              selection: window.sessionStorage.getItem(
                "expense-tracker-chat-selection:v1:workspace:local:local",
              ),
            };
          }
        }
        throw new Error("Adoption source draft storage key was not found");
      },
      retainedText,
    );
    const destinationStorageKey =
      `expense-tracker-chat-draft:v2:workspace:local:local:${
        encodeURIComponent(`session:${sessionId}`)
      }`;
    const failureStorageKey = failureCase.getStorageKey(
      storageBeforeAdoption.sourceStorageKey,
      sessionId,
    );
    await page.evaluate(
      ({ method, storageKey }): void => {
        type StorageFailureWindow = Window & Readonly<{
          __restoreChatStorageMutation?: () => void;
          __chatStorageMutationFailed?: boolean;
        }>;
        const testWindow = window as StorageFailureWindow;
        const storagePrototype = Storage.prototype;
        const originalSetItem = storagePrototype.setItem;
        const originalRemoveItem = storagePrototype.removeItem;
        const originalMethod = method === "setItem"
          ? originalSetItem
          : originalRemoveItem;
        let hasFailed = false;
        const replacement = function (
          this: Storage,
          key: string,
          value?: string,
        ): void {
          if (
            this === window.sessionStorage
            && key === storageKey
            && !hasFailed
          ) {
            hasFailed = true;
            Object.defineProperty(testWindow, "__chatStorageMutationFailed", {
              configurable: true,
              value: true,
            });
            throw new DOMException(
              `Synthetic adoption storage failure for ${key}`,
              "QuotaExceededError",
            );
          }
          if (method === "setItem") {
            if (value === undefined) {
              throw new Error("Storage setItem replacement requires a value");
            }
            originalSetItem.call(this, key, value);
            return;
          }
          originalRemoveItem.call(this, key);
        };
        Object.defineProperty(storagePrototype, method, {
          configurable: true,
          value: replacement,
          writable: true,
        });
        Object.defineProperty(testWindow, "__restoreChatStorageMutation", {
          configurable: true,
          value: (): void => {
            Object.defineProperty(storagePrototype, method, {
              configurable: true,
              value: originalMethod,
              writable: true,
            });
          },
        });
      },
      {
        method: failureCase.method,
        storageKey: failureStorageKey,
      },
    );

    releaseCreateResponse.resolve();
    await expect.poll(async (): Promise<boolean> =>
      page.evaluate((): boolean =>
        (window as Window & Readonly<{
          __chatStorageMutationFailed?: boolean;
        }>).__chatStorageMutationFailed === true)).toBe(true);
    await expect.poll(async (): Promise<Readonly<{
      sourceText: string | null;
      destinationText: string | null;
      activeDraft: string | null;
      selection: string | null;
    }>> => page.evaluate(
      ({ sourceStorageKey, destinationKey }): Readonly<{
        sourceText: string | null;
        destinationText: string | null;
        activeDraft: string | null;
        selection: string | null;
      }> => ({
        sourceText: window.sessionStorage.getItem(sourceStorageKey),
        destinationText: window.sessionStorage.getItem(destinationKey),
        activeDraft: window.sessionStorage.getItem(
          "expense-tracker-chat-active-draft:v1:workspace:local:local",
        ),
        selection: window.sessionStorage.getItem(
          "expense-tracker-chat-selection:v1:workspace:local:local",
        ),
      }),
      {
        sourceStorageKey: storageBeforeAdoption.sourceStorageKey,
        destinationKey: destinationStorageKey,
      },
    )).toEqual({
      sourceText: storageBeforeAdoption.sourceText,
      destinationText: null,
      activeDraft: storageBeforeAdoption.activeDraft,
      selection: storageBeforeAdoption.selection,
    });
    await expect(page).toHaveURL(
      (url) => url.pathname === "/chat"
        && !url.searchParams.has("session"),
    );
    await expect(composer).toBeEditable();
    await expect(composer).toHaveValue(retainedText);
    await expect(page.getByTestId("chat-prepared-attachment")).toContainText(
      retainedAttachmentName,
    );
    expect(snapshotRequestCount).toBe(0);

    await page.evaluate((): void => {
      const restore = (window as Window & Readonly<{
        __restoreChatStorageMutation?: () => void;
      }>).__restoreChatStorageMutation;
      if (restore === undefined) {
        throw new Error("Storage mutation restore callback is missing");
      }
      restore();
    });
  });
}

test("preserves an edited destination when delayed draft adoption collides", async ({
  page,
  baseURL,
  context,
}) => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }

  const collisionSessionId = "session-adoption-destination-collision";
  const createRequestReceived = createDeferred();
  const releaseCreateResponse = createDeferred();
  const pageErrors: Array<string> = [];
  let exposeCollisionSession = false;
  page.on("pageerror", (error): void => {
    pageErrors.push(error.message);
  });

  await mockWorkspaceClientDependencies(page);
  await page.route(/\/api\/chat\/sessions\?/u, async (route): Promise<void> => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessions: exposeCollisionSession
          ? [{
              sessionId: collisionSessionId,
              title: collisionSessionId,
              lastMessageAt: new Date().toISOString(),
              status: "idle",
              mainContentInvalidationVersion: 0,
            }]
          : [],
        nextCursor: null,
      }),
    });
  });
  await page.route(
    /\/api\/chat\?sessionId=/u,
    async (route): Promise<void> => {
      const sessionId = new URL(route.request().url()).searchParams.get(
        "sessionId",
      );
      if (sessionId !== collisionSessionId) {
        throw new Error(
          `Unexpected collision snapshot sessionId: ${String(sessionId)}`,
        );
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sessionId,
          runState: "idle",
          activeTurnId: null,
          updatedAt: Date.now(),
          mainContentInvalidationVersion: 0,
          messages: [],
        }),
      });
    },
  );
  await page.route("**/api/chat/new", async (route): Promise<void> => {
    exposeCollisionSession = true;
    createRequestReceived.resolve();
    await releaseCreateResponse.promise;
    await route.fulfill({
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "X-Chat-Session-Id": collisionSessionId,
      },
      body: [
        `data: {"type":"session","sessionId":"${collisionSessionId}"}`,
        "data: {\"type\":\"done\"}",
        "",
      ].join("\n\n"),
    });
  });

  const origin = new URL(baseURL);
  await context.addCookies([
    { name: "locale", value: "en", domain: origin.hostname, path: "/", sameSite: "Lax" },
    { name: "chat-open", value: "true", domain: origin.hostname, path: "/", sameSite: "Lax" },
  ]);
  await page.goto("/chat", { waitUntil: "domcontentloaded" });
  const composer = page.getByTestId("chat-composer-input");
  await expect(composer).toBeEditable();
  await composer.fill("first message before collision");
  await page.getByTestId("chat-submit").click();
  await createRequestReceived.promise;
  await composer.fill("obsolete source follow-up");
  await page.getByTestId("chat-file-input").setInputFiles({
    name: "obsolete-source.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("obsolete source attachment"),
  });
  const sourceStorageKey = await page.evaluate(
    (expectedText: string): string => {
      for (let index = 0; index < window.sessionStorage.length; index += 1) {
        const key = window.sessionStorage.key(index);
        if (
          key?.startsWith("expense-tracker-chat-draft:v2:workspace:") === true
          && window.sessionStorage.getItem(key) === expectedText
        ) {
          return key;
        }
      }
      throw new Error("Source collision draft storage key was not found");
    },
    "obsolete source follow-up",
  );

  await page.getByTestId("chat-history-open").click();
  await page.getByTestId(
    `chat-history-session-${collisionSessionId}`,
  ).click();
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("session") === collisionSessionId,
  );
  await expect(composer).toBeEditable();
  await composer.fill("authoritative destination text");
  await page.getByTestId("chat-file-input").setInputFiles({
    name: "authoritative-destination.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("authoritative destination attachment"),
  });
  await expect(page.getByTestId("chat-prepared-attachment")).toContainText(
    "authoritative-destination.txt",
  );

  releaseCreateResponse.resolve();
  await expect(composer).toHaveValue("authoritative destination text");
  await expect(page.getByTestId("chat-prepared-attachment")).toContainText(
    "authoritative-destination.txt",
  );
  await expect(page.getByTestId("chat-prepared-attachment")).not.toContainText(
    "obsolete-source.txt",
  );
  await expect.poll(async (): Promise<string | null> =>
    page.evaluate(
      (storageKey: string): string | null =>
        window.sessionStorage.getItem(storageKey),
      sourceStorageKey,
    )).toBeNull();
  expect(pageErrors).toEqual([]);
});

test("atomically adopts remounted composer work before the first session header", async ({
  page,
  baseURL,
  context,
}) => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }

  await page.addInitScript((): void => {
    class MockMediaRecorder extends EventTarget {
      public static isTypeSupported(_mimeType: string): boolean {
        return true;
      }

      public state: RecordingState = "inactive";
      public readonly mimeType: string;

      public constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
        super();
        this.mimeType = options?.mimeType ?? "audio/webm";
      }

      public start(): void {
        this.state = "recording";
      }

      public stop(): void {
        if (this.state === "inactive") {
          return;
        }
        this.state = "inactive";
        this.dispatchEvent(new BlobEvent("dataavailable", {
          data: new Blob(["recorded audio"], { type: this.mimeType }),
        }));
        this.dispatchEvent(new Event("stop"));
      }
    }

    const mediaStream = {
      getTracks: (): ReadonlyArray<Readonly<{ stop: () => void }>> => [{
        stop: (): void => undefined,
      }],
    };
    let resolvePermission: ((stream: typeof mediaStream) => void) | null = null;
    const permission = new Promise<typeof mediaStream>((resolve): void => {
      resolvePermission = resolve;
    });
    if (resolvePermission === null) {
      throw new Error("Failed to create deferred microphone permission");
    }
    Object.defineProperty(
      window,
      "__resolveChatMicrophonePermission",
      {
        configurable: true,
        value: (): void => resolvePermission?.(mediaStream),
      },
    );
    Object.defineProperty(window, "MediaRecorder", {
      configurable: true,
      value: MockMediaRecorder,
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: async (): Promise<typeof mediaStream> => permission,
      },
    });
  });

  const newChatRequestReceived = createDeferred();
  const releaseNewChatResponse = createDeferred();
  const transcriptionRequestReceived = createDeferred();
  const releaseTranscriptionResponse = createDeferred();
  await page.route("**/api/chat/new", async (route): Promise<void> => {
    newChatRequestReceived.resolve();
    await releaseNewChatResponse.promise;
    await route.fulfill({
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "X-Chat-Session-Id": "session-adopted",
      },
      body: [
        "data: {\"type\":\"session\",\"sessionId\":\"session-adopted\"}",
        "data: {\"type\":\"delta\",\"text\":\"Done\",\"itemId\":\"assistant-1\",\"outputIndex\":0,\"contentIndex\":0,\"sequenceNumber\":0}",
        "data: {\"type\":\"done\"}",
        "",
      ].join("\n\n"),
    });
  });
  await page.route("**/api/chat/transcriptions", async (route): Promise<void> => {
    transcriptionRequestReceived.resolve();
    await releaseTranscriptionResponse.promise;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ text: "dictated after send" }),
    });
  });

  const origin = new URL(baseURL);
  await context.addCookies([
    { name: "demo", value: "true", domain: origin.hostname, path: "/", sameSite: "Lax" },
    { name: "locale", value: "en", domain: origin.hostname, path: "/", sameSite: "Lax" },
    { name: "chat-open", value: "true", domain: origin.hostname, path: "/", sameSite: "Lax" },
  ]);
  await page.goto("/chat", { waitUntil: "domcontentloaded" });

  const composer = page.getByTestId("chat-composer-input");
  await expect(composer).toBeEditable();
  await composer.fill("first message");
  await page.getByTestId("chat-submit").click();
  await newChatRequestReceived.promise;

  await getNavigationLink(page, "/transactions").click();
  await expect(page).toHaveURL(
    (url) => url.pathname === "/transactions",
    { timeout: localNavigationTimeoutMs },
  );
  await expect(page.getByTestId("chat-panel")).toBeVisible();
  await composer.fill("follow-up before adoption");
  await page.getByTestId("chat-file-input").setInputFiles({
    name: "follow-up.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("attachment after send"),
  });
  await expect(page.getByTestId("chat-prepared-attachment")).toContainText(
    "follow-up.txt",
  );

  const dictationButton = page.getByTestId("chat-dictation");
  await dictationButton.click();
  await expect(dictationButton).toBeDisabled();
  const expectedCaret = "follow-up before adoption".length;
  await composer.evaluate((element): void => {
    const textarea = element as HTMLTextAreaElement & {
      __chatRemountAdoptionMarker?: string;
    };
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    textarea.__chatRemountAdoptionMarker = "current-remounted-composer";
  });

  releaseNewChatResponse.resolve();
  await expect(page).toHaveURL(
    (url) => url.pathname === "/transactions"
      && url.searchParams.get("session") === null,
  );
  expect(await composer.evaluate((element): Readonly<{
    marker: string | undefined;
    selectionStart: number;
    selectionEnd: number;
  }> => {
    const textarea = element as HTMLTextAreaElement & {
      __chatRemountAdoptionMarker?: string;
    };
    return {
      marker: textarea.__chatRemountAdoptionMarker,
      selectionStart: textarea.selectionStart,
      selectionEnd: textarea.selectionEnd,
    };
  })).toEqual({
    marker: "current-remounted-composer",
    selectionStart: expectedCaret,
    selectionEnd: expectedCaret,
  });
  await page.evaluate((): void => {
    const resolvePermission =
      (window as DictationTestWindow).__resolveChatMicrophonePermission;
    if (resolvePermission === undefined) {
      throw new Error("Deferred microphone permission resolver is missing");
    }
    resolvePermission();
  });
  await expect(dictationButton).toHaveAttribute("aria-pressed", "true");
  await dictationButton.click();
  await transcriptionRequestReceived.promise;
  releaseTranscriptionResponse.resolve();

  await expect(composer).toHaveValue(/follow-up before adoption/u);
  await expect(composer).toHaveValue(/dictated after send/u);
  await expect(page.getByTestId("chat-prepared-attachment")).toContainText(
    "follow-up.txt",
  );
});

test("preserves composer focus caret and mention state only across exact adoption", async ({
  page,
  baseURL,
  context,
}) => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }

  const adoptedSessionId = "session-lifecycle-adopted";
  const switchedSessionId = "session-lifecycle-switch";
  const createRequestReceived = createDeferred();
  const releaseCreateResponse = createDeferred();
  const snapshotCounts = new Map<string, number>();
  let exposeSessions = false;

  await mockWorkspaceClientDependencies(page);
  await page.route("**/api/account-suggestions", async (route): Promise<void> => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        { accountId: "cash", currency: "USD" },
        { accountId: "card", currency: "EUR" },
      ]),
    });
  });
  await page.route(/\/api\/chat\/sessions\?/u, async (route): Promise<void> => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        sessions: exposeSessions
          ? [adoptedSessionId, switchedSessionId].map((sessionId) => ({
              sessionId,
              title: sessionId,
              lastMessageAt: new Date().toISOString(),
              status: "idle",
              mainContentInvalidationVersion: 0,
            }))
          : [],
        nextCursor: null,
      }),
    });
  });
  await page.route(
    /\/api\/chat\?sessionId=/u,
    async (route): Promise<void> => {
      const sessionId = new URL(route.request().url()).searchParams.get(
        "sessionId",
      );
      if (sessionId !== adoptedSessionId && sessionId !== switchedSessionId) {
        throw new Error(
          `Unexpected lifecycle snapshot sessionId: ${String(sessionId)}`,
        );
      }
      snapshotCounts.set(
        sessionId,
        (snapshotCounts.get(sessionId) ?? 0) + 1,
      );
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sessionId,
          runState: "idle",
          activeTurnId: null,
          updatedAt: Date.now(),
          mainContentInvalidationVersion: 0,
          messages: [],
        }),
      });
    },
  );
  await page.route("**/api/chat/new", async (route): Promise<void> => {
    createRequestReceived.resolve();
    await releaseCreateResponse.promise;
    await route.fulfill({
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "X-Chat-Session-Id": adoptedSessionId,
      },
      body: [
        `data: {"type":"session","sessionId":"${adoptedSessionId}"}`,
        "data: {\"type\":\"done\"}",
        "",
      ].join("\n\n"),
    });
  });

  const origin = new URL(baseURL);
  await context.addCookies([
    { name: "locale", value: "en", domain: origin.hostname, path: "/", sameSite: "Lax" },
  ]);
  await page.goto("/chat", { waitUntil: "domcontentloaded" });
  const composer = page.getByTestId("chat-composer-input");
  await expect(composer).toBeEditable();
  await composer.fill("first lifecycle message");
  await page.getByTestId("chat-submit").click();
  await createRequestReceived.promise;

  const followUpText = "follow-up @ca";
  const mentionCaret = followUpText.length;
  await composer.fill(followUpText);
  await composer.evaluate((element): void => {
    const textarea = element as HTMLTextAreaElement & {
      __chatLifecycleMarker?: string;
    };
    textarea.focus();
    textarea.__chatLifecycleMarker = "preserve-on-adoption";
  });
  await expect(
    page.getByTestId("chat-account-mention-popover"),
  ).toBeVisible();
  await composer.press("ArrowDown");
  const activeMentionId = await composer.getAttribute(
    "aria-activedescendant",
  );
  if (activeMentionId === null) {
    throw new Error("Mention selection did not expose an active descendant");
  }

  exposeSessions = true;
  releaseCreateResponse.resolve();
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("session") === adoptedSessionId,
  );
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue(followUpText);
  await expect(composer).toHaveAttribute(
    "aria-activedescendant",
    activeMentionId,
  );
  expect(await composer.evaluate((element): Readonly<{
    marker: string | undefined;
    selectionStart: number;
    selectionEnd: number;
  }> => {
    const textarea = element as HTMLTextAreaElement & {
      __chatLifecycleMarker?: string;
    };
    return {
      marker: textarea.__chatLifecycleMarker,
      selectionStart: textarea.selectionStart,
      selectionEnd: textarea.selectionEnd,
    };
  })).toEqual({
    marker: "preserve-on-adoption",
    selectionStart: mentionCaret,
    selectionEnd: mentionCaret,
  });

  await page.getByTestId("chat-history-open").click();
  await page.getByTestId(
    `chat-history-session-${switchedSessionId}`,
  ).click();
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("session") === switchedSessionId,
  );
  await expect(composer).toHaveValue("");
  expect(await composer.evaluate((element): string | undefined =>
    (element as HTMLTextAreaElement & {
      __chatLifecycleMarker?: string;
    }).__chatLifecycleMarker)).toBeUndefined();
  await expect(
    page.getByTestId("chat-account-mention-popover"),
  ).toHaveCount(0);

  const roundTripText = "round trip @ca";
  await composer.fill(roundTripText);
  await expect(
    page.getByTestId("chat-account-mention-popover"),
  ).toBeVisible();
  await composer.press("ArrowDown");
  await expect(composer).toHaveAttribute(
    "aria-activedescendant",
    /chat-account-mention-option/u,
  );
  await composer.evaluate((element): void => {
    const textarea = element as HTMLTextAreaElement & {
      __chatLifecycleMarker?: string;
    };
    textarea.focus();
    textarea.setSelectionRange(2, 2);
    textarea.__chatLifecycleMarker = "reset-after-new-epoch";
  });
  const previousSwitchedSnapshotCount =
    snapshotCounts.get(switchedSessionId) ?? 0;
  await page.evaluate(({ firstSessionId, secondSessionId }): void => {
    window.history.pushState(
      window.history.state,
      "",
      `/chat?session=${encodeURIComponent(firstSessionId)}`,
    );
    window.dispatchEvent(new PopStateEvent("popstate"));
    window.history.pushState(
      window.history.state,
      "",
      `/chat?session=${encodeURIComponent(secondSessionId)}`,
    );
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, {
    firstSessionId: adoptedSessionId,
    secondSessionId: switchedSessionId,
  });
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("session") === switchedSessionId,
  );
  await expect.poll((): number =>
    snapshotCounts.get(switchedSessionId) ?? 0).toBeGreaterThan(
      previousSwitchedSnapshotCount,
    );
  await expect(composer).toHaveValue(roundTripText);
  await expect(composer).not.toBeFocused();
  await expect(composer).not.toHaveAttribute("aria-activedescendant");
  expect(await composer.evaluate((element): string | undefined =>
    (element as HTMLTextAreaElement & {
      __chatLifecycleMarker?: string;
    }).__chatLifecycleMarker)).toBeUndefined();
});
