import { expect, test, type Locator, type Page } from "@playwright/test";

type ResolvedTheme = "light" | "dark";
type Rgb = readonly [number, number, number];

const expectTheme = async (page: Page, theme: ResolvedTheme): Promise<void> => {
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await expect(page.locator("html")).toHaveCSS("color-scheme", theme);
};

const expectThemeCookie = async (page: Page, value: string): Promise<void> => {
  await expect.poll(async (): Promise<string | undefined> =>
    (await page.context().cookies()).find((cookie): boolean => cookie.name === "theme")?.value,
  ).toBe(value);
};

const parseRgb = (color: string): Rgb => {
  const match = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*[\d.]+)?\)$/.exec(color);
  if (match === null) throw new Error(`Expected a computed RGB color, received ${color}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
};

const luminance = (rgb: Rgb): number => {
  const linear = rgb.map((channel): number => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
};

const expectReadableDarkSurface = async (locator: Locator): Promise<void> => {
  await expect(locator).toBeVisible();
  const colors = await locator.evaluate((element): Readonly<{
    foreground: string;
    background: string;
  }> => {
    let ancestor: Element | null = element;
    while (ancestor !== null) {
      const background = getComputedStyle(ancestor).backgroundColor;
      if (background !== "rgba(0, 0, 0, 0)" && background !== "transparent") {
        return { foreground: getComputedStyle(element).color, background };
      }
      ancestor = ancestor.parentElement;
    }
    throw new Error("Visible theme surface has no opaque ancestor background");
  });
  const foreground = luminance(parseRgb(colors.foreground));
  const background = luminance(parseRgb(colors.background));
  expect(background, `Surface background ${colors.background}`).toBeLessThan(0.1);
  expect(
    (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05),
    `Text contrast: ${colors.foreground} on ${colors.background}`,
  ).toBeGreaterThanOrEqual(4.5);
};

test.beforeEach(async ({ context, baseURL }): Promise<void> => {
  if (baseURL === undefined) throw new Error("Local Demo Playwright baseURL is required");
  const domain = new URL(baseURL).hostname;
  await context.addCookies([
    { name: "demo", value: "true", domain, path: "/", sameSite: "Lax" },
    { name: "locale", value: "en", domain, path: "/", sameSite: "Lax" },
    { name: "chat-open", value: "false", domain, path: "/", sameSite: "Lax" },
  ]);
});

test("uses the system theme on first load and follows live system changes", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript((): void => {
    document.addEventListener("DOMContentLoaded", (): void => {
      document.documentElement.setAttribute(
        "data-theme-at-dom-ready",
        document.documentElement.dataset.theme ?? "missing",
      );
    }, { once: true });
  });
  await page.goto("/settings", { waitUntil: "domcontentloaded" });
  await expectTheme(page, "dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme-at-dom-ready", "dark");
  await expect(page.locator("#appearance-theme")).toHaveValue("system");

  await page.emulateMedia({ colorScheme: "light" });
  await expectTheme(page, "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expectTheme(page, "dark");
});

test("applies explicit choices immediately and preserves them across navigation and reload", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/settings", { waitUntil: "domcontentloaded" });
  const select = page.locator("#appearance-theme");
  await select.selectOption("dark");
  await expectTheme(page, "dark");
  await expectThemeCookie(page, "dark");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.emulateMedia({ colorScheme: "light" });
  await expectTheme(page, "dark");

  await page.locator('nav a[href="/budget"]').click();
  await expect(page).toHaveURL(/\/budget$/);
  await expectTheme(page, "dark");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expectTheme(page, "dark");
  await page.locator('nav a[href="/settings"]').click();
  await expect(select).toHaveValue("dark");

  await select.selectOption("light");
  await expectTheme(page, "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expectTheme(page, "light");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(select).toHaveValue("light");
  await expectTheme(page, "light");
});

test("keeps theme selection usable when browser storage is unavailable", async ({ page }) => {
  await page.addInitScript((): void => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get(): never {
        throw new DOMException("Storage unavailable for theme test", "SecurityError");
      },
    });
  });
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/settings", { waitUntil: "domcontentloaded" });
  const select = page.locator("#appearance-theme");
  await expect(select).toHaveValue("system");
  await select.selectOption("dark");
  await expectTheme(page, "dark");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.emulateMedia({ colorScheme: "light" });
  await expectTheme(page, "dark");
  await select.selectOption("system");
  await expectTheme(page, "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expectTheme(page, "dark");
});

test("renders readable dark page surfaces, budget editing, and chat controls", async ({ page }) => {
  test.setTimeout(120_000);
  await page.emulateMedia({ colorScheme: "dark" });
  for (const path of ["/settings", "/budget", "/transactions", "/balances", "/dashboards"]) {
    await page.goto(path, { waitUntil: "domcontentloaded" });
    await expectTheme(page, "dark");
    await expectReadableDarkSurface(page.locator("body"));
    await expectReadableDarkSurface(page.locator("main h1").first());
    if (path === "/settings") {
      await expectReadableDarkSurface(page.locator("#appearance-theme"));
    }
    if (path === "/budget") {
      const openButton = page.locator('[data-testid^="budget-plan-open-budget-plan:"]').first();
      await expect(openButton).toBeVisible();
      const testId = await openButton.getAttribute("data-testid");
      if (testId === null) throw new Error("Budget plan editor trigger requires its test ID");
      const editorId = testId.slice("budget-plan-open-".length);
      await openButton.click();
      await expectReadableDarkSurface(page.getByTestId(`budget-plan-base-input-${editorId}`));
      await page.keyboard.press("Escape");
    }
    if (path === "/transactions" || path === "/balances") {
      await expect(page.locator("main table").first()).toBeVisible();
    }
  }
  await page.goto("/chat", { waitUntil: "domcontentloaded" });
  await expectTheme(page, "dark");
  await expectReadableDarkSurface(page.getByTestId("chat-composer-input"));
});

test("keeps mobile RTL settings stable and supports keyboard selection in English", async ({ page, context, baseURL }) => {
  if (baseURL === undefined) throw new Error("Local Demo Playwright baseURL is required");
  await page.setViewportSize({ width: 390, height: 844 });
  await context.addCookies([
    { name: "locale", value: "ar", domain: new URL(baseURL).hostname, path: "/", sameSite: "Lax" },
  ]);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/settings", { waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  const select = page.locator("#appearance-theme");
  await expectReadableDarkSurface(select);
  await expect(select).toBeEnabled();
  await select.scrollIntoViewIfNeeded();
  const originalBounds = await select.boundingBox();
  if (originalBounds === null) throw new Error("Appearance select must have measurable mobile bounds");
  expect(originalBounds.x).toBeGreaterThanOrEqual(0);
  expect(originalBounds.x + originalBounds.width).toBeLessThanOrEqual(390);

  await select.selectOption("light");
  await expect(select).toHaveValue("light");
  await expectTheme(page, "light");
  await select.selectOption("dark");
  await expectTheme(page, "dark");
  await expectReadableDarkSurface(select);
  const darkBounds = await select.boundingBox();
  if (darkBounds === null) throw new Error("Theme select must retain measurable bounds");
  expect(darkBounds.x + darkBounds.width).toEqual(originalBounds.x + originalBounds.width);
  expect(darkBounds.y).toEqual(originalBounds.y);
  expect(darkBounds.height).toEqual(originalBounds.height);

  // macOS headless Chromium cannot navigate native popups with arrow keys,
  // and Playwright's keyboard layout cannot type Arabic option initials.
  // Exercise native keyboard typeahead using the English option labels.
  await context.addCookies([
    { name: "locale", value: "en", domain: new URL(baseURL).hostname, path: "/", sameSite: "Lax" },
  ]);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(select).toBeEnabled();
  await select.focus();
  await page.keyboard.press("l");
  await page.keyboard.press("Enter");
  await expect(select).toHaveValue("light");
  await expectTheme(page, "light");
  await expect(select).toBeFocused();
  await expect(select).toHaveCSS("outline-style", "solid");
  expect(await select.evaluate((element): number =>
    Number.parseFloat(getComputedStyle(element).outlineWidth),
  )).toBeGreaterThan(0);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await expect(select).toBeFocused();
  await page.keyboard.press("d");
  await page.keyboard.press("Enter");
  await expect(select).toHaveValue("dark");
  await expectTheme(page, "dark");
  await expectReadableDarkSurface(select);
});

const userSettingsPanel = (page: Page): Locator => page.locator("section.panel").filter({ has: page.locator("#user-lowercase") });

test("groups appearance under user settings and keeps dropdown arrows inset in LTR and RTL", async ({ page, context, baseURL }, testInfo) => {
  if (baseURL === undefined) throw new Error("Local Demo Playwright baseURL is required");
  for (const locale of ["en", "ar"]) {
    await context.addCookies([{ name: "locale", value: locale, domain: new URL(baseURL).hostname, path: "/" }]);
    await page.setViewportSize(locale === "en" ? { width: 1440, height: 1000 } : { width: 390, height: 844 });
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await page.goto("/settings", { waitUntil: "domcontentloaded" });
      await expect(page.locator("#appearance-theme")).toBeEnabled();
      await expect(userSettingsPanel(page).locator("#appearance-theme")).toBeVisible();
      await expect(page.getByRole("heading", { name: "Appearance", exact: true })).toHaveCount(0);
      const select = page.locator("#appearance-theme");
      const geometry = await select.evaluate((element) => {
        const style = getComputedStyle(element);
        const arrow = getComputedStyle(element.parentElement!, "::after");
        return {
          width: element.getBoundingClientRect().width,
          appearance: style.appearance,
          paddingEnd: Number.parseFloat(style.paddingInlineEnd),
          arrowInset: Number.parseFloat(arrow.insetInlineEnd),
          arrowSize: Number.parseFloat(arrow.width),
          pointerEvents: arrow.pointerEvents,
        };
      });
      expect(geometry.appearance).toBe("none");
      expect(geometry.arrowInset).toBeGreaterThanOrEqual(10);
      expect(geometry.paddingEnd).toBeGreaterThan(geometry.arrowInset + geometry.arrowSize + 8);
      expect(geometry.pointerEvents).toBe("none");
      // The theme selector should size to its choices without the old minimum-width gap.
      if (locale === "en") expect(geometry.width).toBeLessThan(110);
      for (const control of await page.locator("main select").all()) {
        await control.scrollIntoViewIfNeeded();
        const bounds = await control.boundingBox();
        if (bounds === null) throw new Error("Settings dropdown must have measurable bounds");
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(page.viewportSize()!.width);
      }
      await page.locator("main").evaluate((element) => { element.parentElement!.scrollTop = 0; });
      await page.screenshot({ path: testInfo.outputPath(`settings-${locale}-${colorScheme}.png`) });
    }
  }
});

test("previews and saves lowercase across app pages and reload without changing entered text", async ({ page }, testInfo) => {
  await page.goto("/settings", { waitUntil: "domcontentloaded" });
  const checkbox = page.locator("#user-lowercase");
  const save = userSettingsPanel(page).getByRole("button", { name: "Save", exact: true });
  await expect(checkbox).not.toBeChecked();
  await expect(save).toBeDisabled();
  await checkbox.check();
  await expect(page.locator("html")).toHaveAttribute("data-lowercase", "true");
  await expect(save).toBeEnabled();
  await save.click();
  await expect(save).toBeDisabled();
  await expect.poll(async () => (await page.context().cookies()).find((cookie) => cookie.name === "lowercase")?.value).toBe("true");

  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      document.documentElement.dataset.lowercaseAtDomReady = document.documentElement.dataset.lowercase;
    }, { once: true });
  });
  for (const path of ["/budget", "/transactions", "/balances", "/dashboards", "/chat", "/settings"]) {
    await page.goto(path, { waitUntil: "domcontentloaded" });
    await expect(page.locator("html")).toHaveAttribute("data-lowercase-at-dom-ready", "true");
    await expect(page.locator("nav")).toHaveCSS("text-transform", "lowercase");
    expect(await page.locator("nav").evaluate((element) => (element as HTMLElement).innerText)).toContain("budget");
    if (path === "/chat") {
      const input = page.getByTestId("chat-composer-input");
      await input.fill("Keep MY Original Text");
      await expect(input).toHaveValue("Keep MY Original Text");
      await expect(input).toHaveCSS("text-transform", "lowercase");
      await expect.poll(() => input.evaluate((element) => getComputedStyle(element, "::placeholder").textTransform)).toBe("lowercase");
    }
    if (path === "/settings") {
      await expect(checkbox).toBeChecked();
      // This component normally forces uppercase; lowercase must override it too.
      await expect(page.locator('section.panel p').filter({ hasText: "Danger Zone" }).first()).toHaveCSS("text-transform", "lowercase");
      await page.screenshot({ path: testInfo.outputPath("settings-lowercase.png") });
    }
  }

  await checkbox.uncheck();
  await save.click();
  await expect(save).toBeDisabled();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(checkbox).not.toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-lowercase", "false");
  expect(await page.locator("nav").evaluate((element) => (element as HTMLElement).innerText)).toContain("Budget");
});

test("retains an unsaved lowercase preview across navigation and lets failed saves retry", async ({ page }) => {
  await page.goto("/settings", { waitUntil: "domcontentloaded" });
  await page.locator("#user-lowercase").check();
  await page.locator('nav a[href="/budget"]').click();
  await expect(page).toHaveURL(/\/budget$/);
  await page.locator('nav a[href="/settings"]').click();
  await expect(page.locator("#user-lowercase")).toBeChecked();
  const save = userSettingsPanel(page).getByRole("button", { name: "Save", exact: true });
  await expect(save).toBeEnabled();

  await page.route("**/api/user-settings", async (route) => {
    await route.fulfill({ status: 500, contentType: "text/plain", body: "Unable to save settings" });
  }, { times: 1 });
  await save.click();
  await expect(userSettingsPanel(page).getByText("Unable to save settings", { exact: true })).toBeVisible();
  await expect(save).toBeEnabled();

  await page.route("**/api/user-settings", (route) => route.abort(), { times: 1 });
  await save.click();
  await expect(userSettingsPanel(page).getByText(/Failed to fetch|NetworkError/)).toBeVisible();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(save).toBeDisabled();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#user-lowercase")).toBeChecked();
});
