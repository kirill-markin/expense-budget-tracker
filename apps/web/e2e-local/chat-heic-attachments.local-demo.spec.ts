import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { CHAT_IMAGE_PREPROCESSING_CONSTRAINTS } from "../src/ui/chat/attachments/imagePreprocessing";

type ImageEncodeObservation = Readonly<{
  width: number;
  height: number;
  mediaType: string;
  bytes: number;
}>;

type InstrumentedWindow = Window & Readonly<{
  __chatImageEncodeObservations?: ReadonlyArray<ImageEncodeObservation>;
  __releaseChatImageEncoding?: () => void;
  __releaseNextChatImageEncoding?: () => void;
  __chatPendingImageEncodingCount?: number;
  __chatImageEncodingCallbackCount?: number;
  __captureNextDeferredPasteTimer?: () => void;
  __deferredPasteTimerCaptured?: boolean;
  __releaseDeferredPasteTimer?: () => void;
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
    throw new Error("Failed to create deferred HEIC browser-test operation");
  }
  return {
    promise,
    resolve: resolvePromise,
  };
};

const fixturePath = resolve(process.cwd(), "e2e-local/fixtures/chat-image.heic");
const encodeCallbackDelayMs = 500;
const fixtureWidth = 48;
const fixtureHeight = 80;

const installDeferredImageEncoding = async (page: Page): Promise<void> => {
  await page.addInitScript((): void => {
    const testWindow = window as InstrumentedWindow;
    const observations: Array<ImageEncodeObservation> = [];
    Object.defineProperty(testWindow, "__chatImageEncodeObservations", {
      value: observations,
      writable: false,
    });

    let releaseEncoding: (() => void) | null = null;
    const encodingRelease = new Promise<void>((resolve): void => {
      releaseEncoding = resolve;
    });
    if (releaseEncoding === null) {
      throw new Error("Failed to create deferred image encoding operation");
    }
    Object.defineProperty(testWindow, "__releaseChatImageEncoding", {
      value: releaseEncoding,
      writable: false,
    });

    const originalToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function toBlob(
      callback: BlobCallback,
      mediaType?: string,
      quality?: number,
    ): void {
      const width = this.width;
      const height = this.height;
      originalToBlob.call(
        this,
        (blob: Blob | null): void => {
          if (blob !== null) {
            observations.push({
              width,
              height,
              mediaType: blob.type,
              bytes: blob.size,
            });
          }
          void encodingRelease.then((): void => callback(blob));
        },
        mediaType,
        quality,
      );
    };
  });
};

const installControllableImageEncoding = async (page: Page): Promise<void> => {
  await page.addInitScript((): void => {
    const testWindow = window as InstrumentedWindow;
    const observations: Array<ImageEncodeObservation> = [];
    const pendingCallbacks: Array<() => void> = [];
    Object.defineProperty(testWindow, "__chatImageEncodeObservations", {
      value: observations,
      writable: false,
    });
    Object.defineProperty(testWindow, "__chatPendingImageEncodingCount", {
      configurable: true,
      value: 0,
    });
    Object.defineProperty(testWindow, "__chatImageEncodingCallbackCount", {
      configurable: true,
      value: 0,
    });

    const publishPendingCount = (): void => {
      Object.defineProperty(testWindow, "__chatPendingImageEncodingCount", {
        configurable: true,
        value: pendingCallbacks.length,
      });
    };
    const originalToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function toBlob(
      callback: BlobCallback,
      mediaType?: string,
      quality?: number,
    ): void {
      const width = this.width;
      const height = this.height;
      originalToBlob.call(
        this,
        (blob: Blob | null): void => {
          if (blob !== null) {
            observations.push({
              width,
              height,
              mediaType: blob.type,
              bytes: blob.size,
            });
          }
          pendingCallbacks.push((): void => {
            callback(blob);
            Object.defineProperty(
              testWindow,
              "__chatImageEncodingCallbackCount",
              {
                configurable: true,
                value:
                  (testWindow.__chatImageEncodingCallbackCount ?? 0) + 1,
              },
            );
          });
          publishPendingCount();
        },
        mediaType,
        quality,
      );
    };
    Object.defineProperty(testWindow, "__releaseNextChatImageEncoding", {
      configurable: true,
      value: (): void => {
        const callback = pendingCallbacks.shift();
        if (callback === undefined) {
          throw new Error("No pending chat image encoding callback exists");
        }
        publishPendingCount();
        callback();
      },
    });
  });
};

const installControllableDeferredPasteTimer = async (
  page: Page,
): Promise<void> => {
  await page.addInitScript((): void => {
    const testWindow = window as InstrumentedWindow;
    const nativeSetTimeout = window.setTimeout.bind(window);
    let shouldCaptureNextZeroDelayTimer = false;
    let capturedTimer: (() => void) | null = null;
    let syntheticTimerId = 2_000_000_000;

    window.setTimeout = ((
      handler: TimerHandler,
      timeout?: number,
      ...args: ReadonlyArray<unknown>
    ): number => {
      if (
        shouldCaptureNextZeroDelayTimer
        && timeout === 0
        && typeof handler === "function"
      ) {
        shouldCaptureNextZeroDelayTimer = false;
        capturedTimer = (): void => handler(...args);
        Object.defineProperty(testWindow, "__deferredPasteTimerCaptured", {
          configurable: true,
          value: true,
        });
        syntheticTimerId += 1;
        return syntheticTimerId;
      }
      return nativeSetTimeout(handler, timeout, ...args);
    }) as typeof window.setTimeout;
    Object.defineProperty(testWindow, "__captureNextDeferredPasteTimer", {
      configurable: true,
      value: (): void => {
        shouldCaptureNextZeroDelayTimer = true;
        capturedTimer = null;
        Object.defineProperty(testWindow, "__deferredPasteTimerCaptured", {
          configurable: true,
          value: false,
        });
      },
    });
    Object.defineProperty(testWindow, "__releaseDeferredPasteTimer", {
      configurable: true,
      value: (): void => {
        const timer = capturedTimer;
        if (timer === null) {
          throw new Error("Deferred paste timer was not captured");
        }
        capturedTimer = null;
        nativeSetTimeout(timer, 0);
      },
    });
  });
};

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

const openDemoChat = async (
  page: Page,
  context: BrowserContext,
  baseURL: string | undefined,
): Promise<void> => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }

  await page.addInitScript((delayMs: number): void => {
    const testWindow = window as InstrumentedWindow;
    const observations: Array<ImageEncodeObservation> = [];
    Object.defineProperty(testWindow, "__chatImageEncodeObservations", {
      value: observations,
      writable: false,
    });

    const originalToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function toBlob(
      callback: BlobCallback,
      mediaType?: string,
      quality?: number,
    ): void {
      const width = this.width;
      const height = this.height;
      originalToBlob.call(
        this,
        (blob: Blob | null): void => {
          if (blob !== null) {
            observations.push({
              width,
              height,
              mediaType: blob.type,
              bytes: blob.size,
            });
          }
          window.setTimeout((): void => callback(blob), delayMs);
        },
        mediaType,
        quality,
      );
    };
  }, encodeCallbackDelayMs);

  const origin = new URL(baseURL);
  await context.addCookies([
    { name: "demo", value: "true", domain: origin.hostname, path: "/", sameSite: "Lax" },
    { name: "locale", value: "en", domain: origin.hostname, path: "/", sameSite: "Lax" },
  ]);

  await page.goto("/chat", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("chat-composer-input")).toBeEditable();
  await expect(page.getByTestId("chat-file-input")).toBeEnabled();
};

const openDemoChatWithControllableImageEncoding = async (
  page: Page,
  context: BrowserContext,
  baseURL: string | undefined,
): Promise<void> => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }
  await installControllableImageEncoding(page);
  const origin = new URL(baseURL);
  await context.addCookies([
    { name: "demo", value: "true", domain: origin.hostname, path: "/", sameSite: "Lax" },
    { name: "locale", value: "en", domain: origin.hostname, path: "/", sameSite: "Lax" },
  ]);
  await page.goto("/chat", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("chat-composer-input")).toBeEditable();
  await expect(page.getByTestId("chat-file-input")).toBeEnabled();
};

const assertPreparedPortraitJpeg = async (
  page: Page,
  expectedFileName: string,
): Promise<void> => {
  const attachment = page.getByTestId("chat-prepared-attachment");
  await expect(attachment).toHaveCount(1);
  await expect(attachment).toContainText(expectedFileName);
  await expect(attachment).toHaveAttribute("data-media-type", "image/jpeg");

  const encodedSize = Number(await attachment.getAttribute("data-encoded-size"));
  expect(Number.isInteger(encodedSize)).toBe(true);
  expect(encodedSize).toBeGreaterThan(0);
  expect(encodedSize).toBeLessThanOrEqual(
    CHAT_IMAGE_PREPROCESSING_CONSTRAINTS.maximumOutputBytes,
  );

  const observations = await page.evaluate((): ReadonlyArray<ImageEncodeObservation> => {
    const value = (window as InstrumentedWindow).__chatImageEncodeObservations;
    if (value === undefined) {
      throw new Error("Image encode instrumentation was not initialized");
    }
    return value;
  });
  expect(observations).toHaveLength(1);
  expect(observations[0]).toEqual({
    width: fixtureWidth,
    height: fixtureHeight,
    mediaType: "image/jpeg",
    bytes: encodedSize,
  });
};

test("preprocesses picker HEIC files sequentially and keeps successes when another file fails", async ({
  page,
  context,
  baseURL,
}) => {
  await openDemoChat(page, context, baseURL);
  const fixture = await readFile(fixturePath);
  const composer = page.getByTestId("chat-composer-input");
  const submit = page.getByTestId("chat-submit");
  await composer.fill("Ready after preprocessing");
  await expect(submit).toBeEnabled();

  await page.getByTestId("chat-file-input").setInputFiles([
    { name: "picker-photo.HEIC", mimeType: "image/heic", buffer: fixture },
    {
      name: "broken-photo.heic",
      mimeType: "image/heic",
      buffer: Buffer.from("not a HEIC image"),
    },
  ]);

  await expect(page.getByTestId("chat-attachment-processing")).toBeVisible();
  await expect(submit).toBeDisabled();
  await expect(page.getByTestId("chat-attachment-processing")).toHaveCount(0);
  await expect(submit).toBeEnabled();
  await assertPreparedPortraitJpeg(page, "picker-photo.jpg");
  await expect(page.getByTestId("chat-attachment-error")).toHaveAttribute(
    "data-file-name",
    "broken-photo.heic",
  );
});

test("discarding drafts invalidates delayed attachment preprocessing without retaining bytes", async ({
  page,
  context,
  baseURL,
}) => {
  await openDemoChatWithControllableImageEncoding(
    page,
    context,
    baseURL,
  );
  const fixture = await readFile(fixturePath);

  for (const [index, fileName] of
    ["discard-one.heic", "discard-two.heic"].entries()) {
    await page.getByTestId("chat-file-input").setInputFiles({
      name: fileName,
      mimeType: "image/heic",
      buffer: fixture,
    });
    await expect(page.getByTestId("chat-attachment-processing")).toBeVisible();
    await expect.poll(async (): Promise<number> =>
      page.evaluate((): number =>
        (window as InstrumentedWindow)
          .__chatPendingImageEncodingCount ?? 0)).toBe(1);
    await page.getByTestId("chat-new").click();
    await expect(page.getByTestId("chat-attachment-processing")).toHaveCount(0);
    await page.evaluate((): void => {
      const release =
        (window as InstrumentedWindow).__releaseNextChatImageEncoding;
      if (release === undefined) {
        throw new Error(
          "Controllable chat image encoding resolver is missing",
        );
      }
      release();
    });
    await expect.poll(async (): Promise<number> =>
      page.evaluate((): number =>
        (window as InstrumentedWindow)
          .__chatImageEncodingCallbackCount ?? 0)).toBe(index + 1);
    await expect(page.getByTestId("chat-prepared-attachment")).toHaveCount(0);
    await expect(page.getByTestId("chat-attachment-error")).toHaveCount(0);
    await expect(page.getByTestId("chat-composer-input")).toHaveValue("");
  }
});

test("detached terminal disposal wins over delayed attachment preprocessing", async ({
  page,
  context,
  baseURL,
}) => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }
  const createRequestReceived = createDeferred();
  const releaseCreateResponse = createDeferred();
  await installDeferredImageEncoding(page);
  await mockWorkspaceClientDependencies(page);
  await page.route(/\/api\/chat\/sessions\?/u, async (route): Promise<void> => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ sessions: [], nextCursor: null }),
    });
  });
  await page.route("**/api/chat/new", async (route): Promise<void> => {
    createRequestReceived.resolve();
    await releaseCreateResponse.promise;
    await route.fulfill({
      status: 400,
      contentType: "text/plain",
      body: "Detached request rejected",
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
  await composer.fill("detached request with delayed preprocessing");
  await page.getByTestId("chat-submit").click();
  await createRequestReceived.promise;
  const retainedText = "detached follow-up must be disposed";
  await composer.fill(retainedText);
  const fixture = await readFile(fixturePath);
  await page.getByTestId("chat-file-input").setInputFiles({
    name: "detached-delayed.heic",
    mimeType: "image/heic",
    buffer: fixture,
  });
  await expect(page.getByTestId("chat-attachment-processing")).toBeVisible();
  const detachedDraftStorageKey = await page.evaluate(
    (expectedText: string): string | null =>
      Object.keys(window.sessionStorage).find(
        (storageKey: string): boolean =>
          storageKey.startsWith("expense-tracker-chat-draft:v2:")
          && window.sessionStorage.getItem(storageKey) === expectedText,
      ) ?? null,
    retainedText,
  );
  if (detachedDraftStorageKey === null) {
    throw new Error("Detached preprocessing draft storage key was not found");
  }

  await page.getByTestId("chat-new").click();
  await expect(composer).toHaveValue("");
  await expect(page.getByTestId("chat-attachment-processing")).toHaveCount(0);
  releaseCreateResponse.resolve();
  await expect.poll(async (): Promise<string | null> =>
    page.evaluate(
      (storageKey: string): string | null =>
        window.sessionStorage.getItem(storageKey),
      detachedDraftStorageKey,
    )).toBeNull();

  await page.evaluate((): void => {
    const releaseEncoding =
      (window as InstrumentedWindow).__releaseChatImageEncoding;
    if (releaseEncoding === undefined) {
      throw new Error("Deferred image encoding resolver is missing");
    }
    releaseEncoding();
  });
  await expect.poll(async (): Promise<number> =>
    page.evaluate((): number =>
      (window as InstrumentedWindow).__chatImageEncodeObservations?.length
      ?? 0)).toBe(1);
  await expect(page.getByTestId("chat-attachment-processing")).toHaveCount(0);
  await expect(page.getByTestId("chat-prepared-attachment")).toHaveCount(0);
  await expect(page.getByTestId("chat-attachment-error")).toHaveCount(0);
  await expect(composer).toHaveValue("");
});

test("retains delayed attachment preprocessing across history selection changes", async ({
  page,
  context,
  baseURL,
}) => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }

  const sessionA = "session-preprocessing-a";
  const sessionB = "session-preprocessing-b";
  const lastMessageAt = new Date().toISOString();
  await installDeferredImageEncoding(page);
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

  const origin = new URL(baseURL);
  await context.addCookies([
    { name: "locale", value: "en", domain: origin.hostname, path: "/", sameSite: "Lax" },
  ]);
  await page.goto(`/chat?session=${sessionA}`, {
    waitUntil: "domcontentloaded",
  });
  await expect(page.getByTestId("chat-composer-input")).toBeEditable();

  const fixture = await readFile(fixturePath);
  await page.getByTestId("chat-file-input").setInputFiles({
    name: "selection-owned.heic",
    mimeType: "image/heic",
    buffer: fixture,
  });
  await expect(page.getByTestId("chat-attachment-processing")).toBeVisible();

  await page.getByTestId("chat-history-open").click();
  await page.getByTestId(`chat-history-session-${sessionB}`).click();
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("session") === sessionB,
  );
  await expect(page.getByTestId("chat-attachment-processing")).toHaveCount(0);
  await expect(page.getByTestId("chat-prepared-attachment")).toHaveCount(0);

  await page.getByTestId("chat-history-open").click();
  await page.getByTestId(`chat-history-session-${sessionA}`).click();
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("session") === sessionA,
  );
  await expect(page.getByTestId("chat-attachment-processing")).toBeVisible();
  await page.evaluate((): void => {
    const releaseEncoding =
      (window as InstrumentedWindow).__releaseChatImageEncoding;
    if (releaseEncoding === undefined) {
      throw new Error("Deferred image encoding resolver is missing");
    }
    releaseEncoding();
  });
  await expect(page.getByTestId("chat-attachment-processing")).toHaveCount(0);
  await assertPreparedPortraitJpeg(page, "selection-owned.jpg");

  await page.getByTestId("chat-history-open").click();
  await page.getByTestId(`chat-history-session-${sessionB}`).click();
  await expect(page.getByTestId("chat-prepared-attachment")).toHaveCount(0);
  await page.getByTestId("chat-history-open").click();
  await page.getByTestId(`chat-history-session-${sessionA}`).click();
  await expect(page.getByTestId("chat-prepared-attachment")).toContainText(
    "selection-owned.jpg",
  );
});

test("isolates delayed attachment preprocessing across provider scopes", async ({
  page,
  context,
  baseURL,
}) => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }

  await installDeferredImageEncoding(page);
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
  const origin = new URL(baseURL);
  await context.addCookies([
    { name: "locale", value: "en", domain: origin.hostname, path: "/", sameSite: "Lax" },
  ]);
  await page.goto("/chat", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("chat-file-input")).toBeEnabled();

  const fixture = await readFile(fixturePath);
  await page.getByTestId("chat-file-input").setInputFiles({
    name: "old-workspace-scope.heic",
    mimeType: "image/heic",
    buffer: fixture,
  });
  await expect(page.getByTestId("chat-attachment-processing")).toBeVisible();

  await page.evaluate((): void => {
    document.cookie = "demo=true; path=/; max-age=31536000";
    const channel = new BroadcastChannel(
      "expense-tracker-main-content-invalidation",
    );
    channel.postMessage({
      type: "main_content_invalidation",
      workspaceId: "local",
      version: 3,
      sourceId: "attachment-scope-change-test",
      emittedAt: Date.now(),
    });
    channel.close();
  });
  await expect(page.getByTestId("mode-demo")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByTestId("chat-attachment-processing")).toHaveCount(0);
  await expect(page.getByTestId("chat-file-input")).toBeEnabled();

  await page.getByTestId("chat-file-input").setInputFiles({
    name: "new-demo-scope.heic",
    mimeType: "image/heic",
    buffer: fixture,
  });
  await expect(page.getByTestId("chat-attachment-processing")).toBeVisible();
  await page.evaluate((): void => {
    const releaseEncoding =
      (window as InstrumentedWindow).__releaseChatImageEncoding;
    if (releaseEncoding === undefined) {
      throw new Error("Deferred image encoding resolver is missing");
    }
    releaseEncoding();
  });

  await expect(page.getByTestId("chat-attachment-processing")).toHaveCount(0);
  await expect(page.getByTestId("chat-prepared-attachment")).toHaveCount(1);
  await expect(page.getByTestId("chat-prepared-attachment")).toContainText(
    "new-demo-scope.jpg",
  );
  await expect(page.getByTestId("chat-prepared-attachment")).not.toContainText(
    "old-workspace-scope.jpg",
  );
  await expect(page.getByTestId("chat-attachment-error")).toHaveCount(0);
  await expect.poll(async (): Promise<number> =>
    page.evaluate((): number =>
      (window as InstrumentedWindow).__chatImageEncodeObservations?.length
      ?? 0)).toBe(2);
});

test("remounted attachment preprocessing follows the exact first-session adoption", async ({
  page,
  context,
  baseURL,
}) => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }
  const newChatRequestReceived = createDeferred();
  const releaseNewChatResponse = createDeferred();
  const adoptedSnapshotRequestReceived = createDeferred();
  const releaseAdoptedSnapshotResponse = createDeferred();
  await page.route("**/api/chat/new", async (route): Promise<void> => {
    newChatRequestReceived.resolve();
    await releaseNewChatResponse.promise;
    await route.fulfill({
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "X-Chat-Session-Id": "session-heic-adopted",
      },
      body: [
        "data: {\"type\":\"session\",\"sessionId\":\"session-heic-adopted\"}",
        "data: {\"type\":\"delta\",\"text\":\"Done\",\"itemId\":\"assistant-1\",\"outputIndex\":0,\"contentIndex\":0,\"sequenceNumber\":0}",
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
      if (sessionId !== "session-heic-adopted") {
        throw new Error(
          `Unexpected adopted HEIC snapshot sessionId: ${String(sessionId)}`,
        );
      }
      adoptedSnapshotRequestReceived.resolve();
      await releaseAdoptedSnapshotResponse.promise;
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
  await installDeferredImageEncoding(page);
  await mockWorkspaceClientDependencies(page);
  const origin = new URL(baseURL);
  await context.addCookies([
    { name: "demo", value: "true", domain: origin.hostname, path: "/", sameSite: "Lax" },
    { name: "locale", value: "en", domain: origin.hostname, path: "/", sameSite: "Lax" },
    { name: "chat-open", value: "true", domain: origin.hostname, path: "/", sameSite: "Lax" },
  ]);
  await page.goto("/chat", { waitUntil: "domcontentloaded" });
  const fixture = await readFile(fixturePath);
  const composer = page.getByTestId("chat-composer-input");
  await expect(composer).toBeEditable();
  await composer.fill("first message");
  await page.getByTestId("chat-submit").click();
  await newChatRequestReceived.promise;

  await page.getByRole("navigation").locator('a[href="/transactions"]').click();
  await expect(page).toHaveURL((url) => url.pathname === "/transactions");
  await expect(page.getByTestId("chat-panel")).toBeVisible();
  await composer.fill("follow-up after remount");
  await page.getByTestId("chat-file-input").setInputFiles({
    name: "pending-adoption.heic",
    mimeType: "image/heic",
    buffer: fixture,
  });
  await expect(page.getByTestId("chat-attachment-processing")).toBeVisible();
  const expectedCaret = "follow-up after remount".length;
  await composer.evaluate((element): void => {
    const textarea = element as HTMLTextAreaElement & {
      __chatRemountAttachmentMarker?: string;
    };
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    textarea.__chatRemountAttachmentMarker = "remounted-attachment-owner";
  });
  releaseNewChatResponse.resolve();

  await adoptedSnapshotRequestReceived.promise;
  await expect.poll(async (): Promise<string | null> =>
    page.evaluate((): string | null =>
      window.sessionStorage.getItem(
        "expense-tracker-chat-selection:v1:demo:local",
      ))).toBe(JSON.stringify({
    kind: "session",
    sessionId: "session-heic-adopted",
    selectionReason: "explicit",
  }));
  await expect(composer).toBeEditable();
  await expect(composer).toBeFocused();
  await expect(page.getByTestId("chat-submit")).toBeDisabled();
  await expect(page.getByTestId("chat-file-input")).toBeDisabled();
  await expect(page.getByTestId("chat-dictation")).toBeDisabled();
  expect(await composer.evaluate((element): Readonly<{
    marker: string | undefined;
    selectionStart: number;
    selectionEnd: number;
  }> => {
    const textarea = element as HTMLTextAreaElement & {
      __chatRemountAttachmentMarker?: string;
    };
    return {
      marker: textarea.__chatRemountAttachmentMarker,
      selectionStart: textarea.selectionStart,
      selectionEnd: textarea.selectionEnd,
    };
  })).toEqual({
    marker: "remounted-attachment-owner",
    selectionStart: expectedCaret,
    selectionEnd: expectedCaret,
  });
  releaseAdoptedSnapshotResponse.resolve();
  await page.evaluate((): void => {
    const releaseEncoding =
      (window as InstrumentedWindow).__releaseChatImageEncoding;
    if (releaseEncoding === undefined) {
      throw new Error("Deferred image encoding resolver is missing");
    }
    releaseEncoding();
  });
  await expect(page.getByTestId("chat-attachment-processing")).toHaveCount(0);
  await expect(page.getByTestId("chat-prepared-attachment")).toContainText(
    "pending-adoption.jpg",
  );
  await expect(composer).toHaveValue("follow-up after remount");
});

test("deferred ambiguous paste follows exact adoption and cancels on navigation", async ({
  page,
  context,
  baseURL,
}) => {
  const fixture = await readFile(fixturePath);
  const createRequestReceived = createDeferred();
  const releaseCreateResponse = createDeferred();
  const pageErrors: Array<string> = [];
  page.on("pageerror", (error): void => {
    pageErrors.push(error.message);
  });
  await installControllableDeferredPasteTimer(page);
  await page.route("**/api/chat/new", async (route): Promise<void> => {
    createRequestReceived.resolve();
    await releaseCreateResponse.promise;
    await route.fulfill({
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "X-Chat-Session-Id": "session-deferred-paste-adopted",
      },
      body: [
        "data: {\"type\":\"session\",\"sessionId\":\"session-deferred-paste-adopted\"}",
        "data: {\"type\":\"done\"}",
        "",
      ].join("\n\n"),
    });
  });
  await openDemoChat(page, context, baseURL);

  const composer = page.getByTestId("chat-composer-input");
  await composer.fill("create before deferred paste");
  await page.getByTestId("chat-submit").click();
  await createRequestReceived.promise;

  const adoptedPasteAccepted = await composer.evaluate(
    (element, bytes: ReadonlyArray<number>): boolean => {
      const testWindow = window as InstrumentedWindow;
      const captureTimer = testWindow.__captureNextDeferredPasteTimer;
      if (captureTimer === undefined) {
        throw new Error("Deferred paste timer capture is unavailable");
      }
      captureTimer();
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", "native adopted paste text");
      clipboardData.items.add(new File(
        [Uint8Array.from(bytes)],
        "",
        { type: "application/octet-stream" },
      ));
      return element.dispatchEvent(new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }));
    },
    Array.from(fixture),
  );
  expect(adoptedPasteAccepted).toBe(true);
  await expect.poll(async (): Promise<boolean> =>
    page.evaluate((): boolean =>
      (window as InstrumentedWindow).__deferredPasteTimerCaptured === true),
  ).toBe(true);
  await expect(page.getByTestId("chat-attachment-processing")).toBeVisible();

  releaseCreateResponse.resolve();
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("session")
      === "session-deferred-paste-adopted",
  );
  await page.evaluate((): void => {
    const releaseTimer =
      (window as InstrumentedWindow).__releaseDeferredPasteTimer;
    if (releaseTimer === undefined) {
      throw new Error("Deferred paste timer release is unavailable");
    }
    releaseTimer();
  });
  await expect(page.getByTestId("chat-attachment-processing")).toHaveCount(0);
  await assertPreparedPortraitJpeg(page, "clipboard-image.jpg");

  await page.getByTestId("chat-new").click();
  await expect(page.getByTestId("chat-prepared-attachment")).toHaveCount(0);
  const canceledPasteAccepted = await composer.evaluate(
    (element, bytes: ReadonlyArray<number>): boolean => {
      const testWindow = window as InstrumentedWindow;
      const captureTimer = testWindow.__captureNextDeferredPasteTimer;
      if (captureTimer === undefined) {
        throw new Error("Deferred paste timer capture is unavailable");
      }
      captureTimer();
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", "native canceled paste text");
      clipboardData.items.add(new File(
        [Uint8Array.from(bytes)],
        "",
        { type: "application/octet-stream" },
      ));
      return element.dispatchEvent(new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }));
    },
    Array.from(fixture),
  );
  expect(canceledPasteAccepted).toBe(true);
  await expect.poll(async (): Promise<boolean> =>
    page.evaluate((): boolean =>
      (window as InstrumentedWindow).__deferredPasteTimerCaptured === true),
  ).toBe(true);
  await expect(page.getByTestId("chat-attachment-processing")).toBeVisible();

  await page.getByTestId("chat-new").click();
  await page.evaluate((): void => {
    const releaseTimer =
      (window as InstrumentedWindow).__releaseDeferredPasteTimer;
    if (releaseTimer === undefined) {
      throw new Error("Deferred paste timer release is unavailable");
    }
    releaseTimer();
  });
  await expect(page.getByTestId("chat-attachment-processing")).toHaveCount(0);
  await expect(page.getByTestId("chat-prepared-attachment")).toHaveCount(0);
  await expect(page.getByTestId("chat-attachment-error")).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test("preserves opaque clipboard text paste and preprocesses a generic HEIC file", async ({
  page,
  context,
  baseURL,
}) => {
  await openDemoChat(page, context, baseURL);
  const fixture = await readFile(fixturePath);
  const composer = page.getByTestId("chat-composer-input");

  const ordinaryTextPasteAccepted = await composer.evaluate((element): boolean => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", "ordinary text");
    return element.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData,
    }));
  });
  expect(ordinaryTextPasteAccepted).toBe(true);

  const unsupportedPasteResult = await composer.evaluate((element): Readonly<{
    accepted: boolean;
    textareaDisabled: boolean;
  }> => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", "keep this text");
    clipboardData.items.add(new File(
      [Uint8Array.from([0x00, 0x01, 0x02, 0x03])],
      "",
      { type: "application/octet-stream" },
    ));
    const accepted = element.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData,
    }));
    return {
      accepted,
      textareaDisabled: (element as HTMLTextAreaElement).disabled,
    };
  });
  expect(unsupportedPasteResult).toEqual({
    accepted: true,
    textareaDisabled: false,
  });
  await expect(page.getByTestId("chat-attachment-processing")).toHaveCount(0);
  await expect(page.getByTestId("chat-prepared-attachment")).toHaveCount(0);
  await expect(page.getByTestId("chat-attachment-error")).toHaveAttribute(
    "data-file-name",
    "clipboard-image",
  );

  const heicPasteAccepted = await composer.evaluate(
    (element, bytes: ReadonlyArray<number>): boolean => {
      const clipboardData = new DataTransfer();
      clipboardData.items.add(new File(
        [Uint8Array.from(bytes)],
        "",
        { type: "application/octet-stream" },
      ));
      return element.dispatchEvent(new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }));
    },
    Array.from(fixture),
  );

  expect(heicPasteAccepted).toBe(true);
  await expect(page.getByTestId("chat-attachment-processing")).toHaveCount(0);
  await assertPreparedPortraitJpeg(page, "clipboard-image.jpg");
});

test("preprocesses a dropped HEIC and focuses the composer after success", async ({
  page,
  context,
  baseURL,
}) => {
  await openDemoChat(page, context, baseURL);
  const fixture = await readFile(fixturePath);
  const composer = page.getByTestId("chat-composer-input");
  const chatPanel = page.getByTestId("chat-panel");

  const dataTransfer = await page.evaluateHandle(
    (bytes: ReadonlyArray<number>): DataTransfer => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File(
        [Uint8Array.from(bytes)],
        "drop-photo.heic",
        { type: "image/heic" },
      ));
      return dataTransfer;
    },
    Array.from(fixture),
  );
  const droppedFileCount = await dataTransfer.evaluate((value: DataTransfer): number =>
    value.files.length);
  expect(droppedFileCount).toBe(1);

  const dragEnterAccepted = await chatPanel.evaluate(
    (element, value: DataTransfer): boolean => element.dispatchEvent(new DragEvent(
      "dragenter",
      {
        bubbles: true,
        cancelable: true,
        dataTransfer: value,
      },
    )),
    dataTransfer,
  );
  expect(dragEnterAccepted).toBe(false);
  await expect(page.getByTestId("chat-drop-overlay")).toBeVisible();
  await chatPanel.evaluate(
    (element, value: DataTransfer): void => {
      element.dispatchEvent(new DragEvent("dragover", {
        bubbles: true,
        cancelable: true,
        dataTransfer: value,
      }));
      element.dispatchEvent(new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: value,
      }));
    },
    dataTransfer,
  );
  await dataTransfer.dispose();

  await expect(page.getByTestId("chat-attachment-processing")).toHaveCount(0);
  await assertPreparedPortraitJpeg(page, "drop-photo.jpg");
  await expect(composer).toBeFocused();
});

test("delayed dropped-file completion does not focus another selected chat", async ({
  page,
  context,
  baseURL,
}) => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }
  const sessionA = "session-delayed-drop-a";
  const sessionB = "session-delayed-drop-b";
  const lastMessageAt = new Date().toISOString();
  await installDeferredImageEncoding(page);
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
          `Unexpected delayed-drop snapshot sessionId: ${String(sessionId)}`,
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
  await expect(page.getByTestId("chat-composer-input")).toBeEditable();

  const fixture = await readFile(fixturePath);
  const dataTransfer = await page.evaluateHandle(
    (bytes: ReadonlyArray<number>): DataTransfer => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(
        [Uint8Array.from(bytes)],
        "delayed-drop.heic",
        { type: "image/heic" },
      ));
      return transfer;
    },
    Array.from(fixture),
  );
  await page.getByTestId("chat-panel").evaluate(
    (element, transfer: DataTransfer): void => {
      element.dispatchEvent(new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }));
    },
    dataTransfer,
  );
  await dataTransfer.dispose();
  await expect(page.getByTestId("chat-attachment-processing")).toBeVisible();

  await page.getByTestId("chat-history-open").click();
  await page.getByTestId(`chat-history-session-${sessionB}`).click();
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("session") === sessionB,
  );
  const historyButton = page.getByTestId("chat-history-open");
  await historyButton.focus();
  await expect(historyButton).toBeFocused();
  await page.evaluate((): void => {
    const releaseEncoding =
      (window as InstrumentedWindow).__releaseChatImageEncoding;
    if (releaseEncoding === undefined) {
      throw new Error("Deferred image encoding resolver is missing");
    }
    releaseEncoding();
  });
  await expect.poll(async (): Promise<number> =>
    page.evaluate((): number =>
      (window as InstrumentedWindow).__chatImageEncodeObservations?.length
      ?? 0)).toBe(1);
  await expect(historyButton).toBeFocused();
  await expect(page.getByTestId("chat-composer-input")).not.toBeFocused();
  await expect(page.getByTestId("chat-prepared-attachment")).toHaveCount(0);

  await historyButton.click();
  await page.getByTestId(`chat-history-session-${sessionA}`).click();
  await expect(page).toHaveURL(
    (url) => url.searchParams.get("session") === sessionA,
  );
  await assertPreparedPortraitJpeg(page, "delayed-drop.jpg");
});
