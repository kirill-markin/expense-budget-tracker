import { expect, test, type Route } from "@playwright/test";
import { z } from "zod";

const demoTransactionsPageSchema = z.object({
  entries: z.array(z.object({
    entryId: z.string().min(1),
    eventId: z.string().min(1),
    amount: z.number().finite(),
    amountReport: z.number().finite().nullable(),
    currency: z.string(),
  })),
});

const clipboardPayloadSchema = z.object({
  entry_id: z.string().min(1),
  event_id: z.string().min(1),
  amount: z.number().finite(),
  amount_report: z.number().finite().nullable(),
});

type Deferred = Readonly<{
  promise: Promise<void>;
  resolve: () => void;
}>;

const createDeferred = (): Deferred => {
  let resolvePromise: () => void = (): void => {
    throw new Error("Deferred resolver was used before initialization");
  };
  const promise = new Promise<void>((resolve): void => {
    resolvePromise = resolve;
  });
  return { promise, resolve: (): void => resolvePromise() };
};

test("copies the final authoritative Demo transaction after its save finishes", async ({ page, baseURL }) => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }

  const origin = new URL(baseURL);
  await page.context().addCookies([
    { name: "demo", value: "true", domain: origin.hostname, path: "/", sameSite: "Lax" },
    { name: "locale", value: "en", domain: origin.hostname, path: "/", sameSite: "Lax" },
  ]);

  const updateGate = createDeferred();
  const updateStarted = createDeferred();

  await page.route("**/api/transactions/update", async (route: Route): Promise<void> => {
    updateStarted.resolve();
    await updateGate.promise;
    await route.continue();
  });

  const initialPageResponse = page.waitForResponse((response): boolean =>
    response.request().method() === "GET"
    && new URL(response.url()).pathname === "/api/transactions",
  );
  await page.goto("/transactions", { waitUntil: "domcontentloaded" });
  const pageResponse = await initialPageResponse;
  const pageBody = demoTransactionsPageSchema.parse(await pageResponse.json());
  const entry = pageBody.entries.find((candidate): boolean => candidate.currency === "EUR");
  if (entry === undefined) {
    throw new Error("Demo transactions did not include an EUR entry for authoritative FX verification");
  }

  const copyAction = page.getByTestId(`transaction-copy-${entry.entryId}`);
  await expect(copyAction).toBeAttached();

  await page.getByTestId(`transaction-amount-${entry.entryId}`).click();
  const amountInput = page.getByTestId(`transaction-amount-input-${entry.entryId}`);
  await expect(amountInput).toBeVisible();
  await amountInput.fill("-123.45");

  const updateResponsePromise = page.waitForResponse((response): boolean =>
    response.request().method() === "POST"
    && new URL(response.url()).pathname === "/api/transactions/update",
  );
  await amountInput.press("Enter");
  await updateStarted.promise;

  await expect(copyAction).toHaveCount(0);

  updateGate.resolve();

  const updateResponse = await updateResponsePromise;
  expect(updateResponse.status()).toBe(200);
  await expect(copyAction).toBeAttached();

  await copyAction.focus();
  await expect(copyAction).toBeFocused();
  await copyAction.click();
  await expect(page.getByTestId("transaction-copy-feedback")).toHaveText("Transaction copied");

  const clipboardText = await page.evaluate(async (): Promise<string> => navigator.clipboard.readText());
  const clipboard = clipboardPayloadSchema.parse(JSON.parse(clipboardText));
  expect(clipboard).toMatchObject({
    entry_id: entry.entryId,
    event_id: entry.eventId,
    amount: -123.45,
    amount_report: -127.03,
  });
});
