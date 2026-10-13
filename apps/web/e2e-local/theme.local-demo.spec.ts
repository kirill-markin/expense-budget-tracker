import { expect, test, type Locator, type Page } from "@playwright/test";

const THEME_STORAGE_KEY = "expense-tracker-theme";
type ResolvedTheme = "light" | "dark";
type Rgb = readonly [number, number, number];

const expectTheme = async (page: Page, theme: ResolvedTheme): Promise<void> => {
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await expect(page.locator("html")).toHaveCSS("color-scheme", theme);
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
  expect(await page.evaluate((key): string | null => localStorage.getItem(key), THEME_STORAGE_KEY))
    .toBe("dark");
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

test("synchronizes preference changes and removal between open tabs", async ({ page, context }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/settings", { waitUntil: "domcontentloaded" });
  const otherPage = await context.newPage();
  await otherPage.emulateMedia({ colorScheme: "light" });
  await otherPage.goto("/settings", { waitUntil: "domcontentloaded" });
  const select = page.locator("#appearance-theme");
  const otherSelect = otherPage.locator("#appearance-theme");

  await select.selectOption("dark");
  await expect(otherSelect).toHaveValue("dark");
  await expectTheme(otherPage, "dark");
  await otherSelect.selectOption("light");
  await expect(select).toHaveValue("light");
  await expectTheme(page, "light");

  await otherPage.evaluate((key): void => localStorage.removeItem(key), THEME_STORAGE_KEY);
  await expect(select).toHaveValue("system");
  await page.emulateMedia({ colorScheme: "dark" });
  await expectTheme(page, "dark");
  await otherPage.close();
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
  expect(await select.boundingBox()).toEqual(originalBounds);

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
