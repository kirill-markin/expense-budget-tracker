import {
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
  type Response,
} from "@playwright/test";

type AccountSuggestion = Readonly<{
  accountId: string;
  currency: string;
}>;

type OpenDemoChatResult = Readonly<{
  suggestions: ReadonlyArray<AccountSuggestion>;
  getSuggestionRequestCount: () => number;
}>;

const parseAccountSuggestions = async (
  response: Response,
): Promise<ReadonlyArray<AccountSuggestion>> => {
  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error("Demo account suggestions response must be an array");
  }

  return payload.map((entry: unknown, index: number): AccountSuggestion => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`Demo account suggestion at index ${index} must be an object`);
    }
    const record = entry as Readonly<Record<string, unknown>>;
    if (typeof record.accountId !== "string" || typeof record.currency !== "string") {
      throw new Error(`Demo account suggestion at index ${index} has invalid fields`);
    }
    if (Object.keys(record).length !== 2) {
      throw new Error(`Demo account suggestion at index ${index} has unexpected fields`);
    }
    return { accountId: record.accountId, currency: record.currency };
  });
};

const openDemoChat = async (
  page: Page,
  context: BrowserContext,
  baseURL: string | undefined,
): Promise<OpenDemoChatResult> => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }

  const origin = new URL(baseURL);
  await context.addCookies([
    { name: "demo", value: "true", domain: origin.hostname, path: "/", sameSite: "Lax" },
    { name: "locale", value: "en", domain: origin.hostname, path: "/", sameSite: "Lax" },
  ]);

  let suggestionRequestCount = 0;
  page.on("request", (request): void => {
    if (new URL(request.url()).pathname === "/api/account-suggestions") {
      suggestionRequestCount += 1;
    }
  });
  const suggestionResponsePromise = page.waitForResponse(
    (response): boolean => new URL(response.url()).pathname === "/api/account-suggestions",
  );

  await page.goto("/chat", { waitUntil: "domcontentloaded" });
  const response = await suggestionResponsePromise;
  expect(response.ok()).toBe(true);
  const suggestions = await parseAccountSuggestions(response);
  expect(suggestions.length).toBeGreaterThan(1);
  await expect(page.getByTestId("chat-composer-input")).toBeEditable();
  await expect.poll(() => suggestionRequestCount).toBe(1);

  return {
    suggestions,
    getSuggestionRequestCount: () => suggestionRequestCount,
  };
};

const expectNoAutomaticSelection = async (
  composer: Locator,
  options: Locator,
): Promise<void> => {
  await expect(options.first()).toHaveAttribute("aria-selected", "false");
  await expect(composer).not.toHaveAttribute("aria-activedescendant", /.+/);
};

const expectCaretAtEnd = async (composer: Locator): Promise<void> => {
  const selection = await composer.evaluate((element): Readonly<{
    start: number;
    end: number;
    length: number;
  }> => {
    const textarea = element as HTMLTextAreaElement;
    return {
      start: textarea.selectionStart,
      end: textarea.selectionEnd,
      length: textarea.value.length,
    };
  });
  expect(selection).toEqual({
    start: selection.length,
    end: selection.length,
    length: selection.length,
  });
};

const expectPopoverAboveComposer = async (
  composer: Locator,
  popover: Locator,
): Promise<void> => {
  const positions = await popover.evaluate(
    (element, textarea): Readonly<{
      popoverBottom: number;
      composerTop: number;
      popoverLeft: number;
      popoverRight: number;
      viewportWidth: number;
    }> => {
      const popoverRect = element.getBoundingClientRect();
      const composerRect = (textarea as HTMLTextAreaElement).getBoundingClientRect();
      return {
        popoverBottom: popoverRect.bottom,
        composerTop: composerRect.top,
        popoverLeft: popoverRect.left,
        popoverRight: popoverRect.right,
        viewportWidth: window.visualViewport?.width ?? window.innerWidth,
      };
    },
    await composer.elementHandle(),
  );
  expect(positions.popoverBottom).toBeLessThan(positions.composerTop);
  expect(positions.popoverLeft).toBeGreaterThanOrEqual(0);
  expect(positions.popoverRight).toBeLessThanOrEqual(positions.viewportWidth);
};

test("uses preloaded account suggestions for desktop mouse and keyboard mentions", async ({
  page,
  context,
  baseURL,
}) => {
  const { suggestions, getSuggestionRequestCount } = await openDemoChat(
    page,
    context,
    baseURL,
  );
  const composer = page.getByTestId("chat-composer-input");
  const popover = page.getByTestId("chat-account-mention-popover");
  const options = page.getByTestId("chat-account-mention-option");

  await composer.fill("@");
  await expect(popover).toBeVisible();
  await expect(options).toHaveCount(Math.min(suggestions.length, 5));
  await expect(options.first()).toHaveAttribute("data-account-id", suggestions[0].accountId);
  await expectNoAutomaticSelection(composer, options);
  await expectPopoverAboveComposer(composer, popover);
  expect(getSuggestionRequestCount()).toBe(1);

  await options.first().click();
  await expect(composer).toHaveValue(`@${suggestions[0].accountId} `);
  await expect(composer).toBeFocused();
  await expectCaretAtEnd(composer);

  await composer.fill("Transfer from @");
  await expectNoAutomaticSelection(composer, options);
  await composer.press("ArrowDown");
  await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");
  await composer.press("ArrowDown");
  await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
  await composer.press("Enter");
  await expect(composer).toHaveValue(`Transfer from @${suggestions[1].accountId} `);
  await expectCaretAtEnd(composer);

  await composer.pressSequentially("to @");
  await expect(popover).toBeVisible();
  await expectNoAutomaticSelection(composer, options);
  await options.first().click();
  await expect(composer).toHaveValue(
    `Transfer from @${suggestions[1].accountId} to @${suggestions[0].accountId} `,
  );
  await expectCaretAtEnd(composer);
  expect(getSuggestionRequestCount()).toBe(1);

  await composer.fill("Send from @");
  await expect(popover).toBeVisible();
  await expectNoAutomaticSelection(composer, options);
  await expect(composer).toHaveAttribute("enterkeyhint", "send");
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
});

test.describe("mobile account mentions", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });

  test("shows four local rows above the composer and inserts on tap", async ({
    page,
    context,
    baseURL,
  }) => {
    const { suggestions, getSuggestionRequestCount } = await openDemoChat(
      page,
      context,
      baseURL,
    );
    const composer = page.getByTestId("chat-composer-input");
    const popover = page.getByTestId("chat-account-mention-popover");
    const options = page.getByTestId("chat-account-mention-option");

    await composer.fill("@");
    await expect(popover).toBeVisible();
    await expect(options).toHaveCount(Math.min(suggestions.length, 4));
    await expectNoAutomaticSelection(composer, options);
    await expectPopoverAboveComposer(composer, popover);

    await options.first().tap();
    await expect(composer).toHaveValue(`@${suggestions[0].accountId} `);
    await expect(composer).toBeFocused();
    await expectCaretAtEnd(composer);
    expect(getSuggestionRequestCount()).toBe(1);
  });
});
