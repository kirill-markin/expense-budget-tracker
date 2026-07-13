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
}>;

const fixturePath = resolve(process.cwd(), "e2e-local/fixtures/chat-image.heic");
const encodeCallbackDelayMs = 500;
const fixtureWidth = 48;
const fixtureHeight = 80;

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
