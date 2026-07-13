import { expect, test, type Locator, type Page } from "@playwright/test";

type NavigationHref = "/chat" | "/transactions";
const localNavigationTimeoutMs = 20_000;

const getNavigationLink = (page: Page, href: NavigationHref): Locator =>
  page.getByRole("navigation").locator(`a[href="${href}"]`);

test("keeps an unsent chat draft within one tab", async ({ page, baseURL, context }) => {
  if (baseURL === undefined) {
    throw new Error("Local Demo Playwright baseURL is required");
  }

  const origin = new URL(baseURL);
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
});
