/**
 * Shared helpers for the live smoke E2E tests.
 *
 * Auth uses Node.js fetch (auth service has no CSRF).
 * App API calls run inside the browser via page.evaluate() + fetch,
 * so the browser naturally handles cookies, CSRF, and Origin headers.
 */
import { type Page, type TestInfo } from "@playwright/test";

const authBaseUrl = process.env.EXPENSE_E2E_AUTH_BASE_URL ?? "https://auth.expense-budget-tracker.com";
const appBaseUrl = process.env.EXPENSE_E2E_APP_BASE_URL ?? "https://app.expense-budget-tracker.com";
const reviewEmail = process.env.EXPENSE_E2E_REVIEW_EMAIL ?? "e2e-test@example.com";
const VISIBILITY_MODE_STORAGE_KEY = "expense-tracker-visibility-mode";
const LAST_ACTIVE_STORAGE_KEY = "expense-tracker-last-active-ts";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export type LiveSmokeScenario = Readonly<{
  runId: string;
  workspaceName: string;
  testAccountId: string;
  testCategory: string;
  aiTransactionTimestamp: string;
  aiTransactionAmount: number;
  aiTransactionCounterparty: string;
  aiTransactionNote: string;
}>;

export const runIdFromClock = (): string => String(Date.now());

export const buildScenario = (runId: string): LiveSmokeScenario => {
  const aiTransactionTimestamp = new Date(Date.now() + 60_000).toISOString();

  return {
    runId,
    workspaceName: `E2E web ${runId}`,
    testAccountId: `E2E Checking ${runId}`,
    testCategory: `E2E Groceries ${runId}`,
    aiTransactionTimestamp,
    aiTransactionAmount: -17.34,
    aiTransactionCounterparty: `E2E AI Merchant ${runId}`,
    aiTransactionNote: `E2E AI note ${runId}`,
  };
};

type DemoSignInResult = Readonly<{
  idToken: string;
  refreshToken: string;
}>;

const isLocalAppBaseUrl = (): boolean => {
  const url = new URL(appBaseUrl);
  return LOCAL_HOSTS.has(url.hostname);
};

const isSecureCookieOrigin = (): boolean => {
  const url = new URL(appBaseUrl);
  return url.protocol === "https:";
};

export const signInWithDemoEmail = async (): Promise<DemoSignInResult> => {
  if (isLocalAppBaseUrl()) {
    return { idToken: "local-dev-id-token", refreshToken: "local-dev-refresh-token" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch(`${authBaseUrl}/api/send-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: reviewEmail }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Demo sign-in failed: ${response.status} ${text}`);
    }

    const body = await response.json() as { ok: boolean; idToken: string; refreshToken: string };
    if (!body.ok || typeof body.idToken !== "string") {
      throw new Error(`Demo sign-in did not return tokens: ${JSON.stringify(body)}`);
    }

    return { idToken: body.idToken, refreshToken: body.refreshToken };
  } finally {
    clearTimeout(timeout);
  }
};

export const setupBrowserSession = async (
  page: Page,
  tokens: DemoSignInResult,
): Promise<void> => {
  const url = new URL(appBaseUrl);
  const domain = url.hostname;
  const secure = isSecureCookieOrigin();

  if (isLocalAppBaseUrl()) {
    await page.goto(appBaseUrl, { waitUntil: "domcontentloaded" });
    return;
  }

  // Set auth cookies so the browser can access the app
  await page.context().addCookies([
    { name: "session", value: tokens.idToken, domain, path: "/", httpOnly: true, secure, sameSite: "Lax" },
    { name: "refresh", value: tokens.refreshToken, domain, path: "/", httpOnly: true, secure, sameSite: "Lax" },
    { name: "logged_in", value: "1", domain, path: "/", httpOnly: false, secure, sameSite: "Lax" },
  ]);

  // Navigate to the app to let the proxy set the __Host-csrf cookie
  await page.goto(appBaseUrl, { waitUntil: "domcontentloaded" });
};

export const setWorkspaceCookie = async (
  page: Page,
  workspaceId: string,
): Promise<void> => {
  const url = new URL(appBaseUrl);
  await page.context().addCookies([
    {
      name: "workspace",
      value: workspaceId,
      domain: url.hostname,
      path: "/",
      httpOnly: false,
      secure: isSecureCookieOrigin(),
      sameSite: "Lax",
    },
  ]);
};

export const ensureAllVisibilityMode = async (
  page: Page,
): Promise<void> => {
  await page.evaluate(
    ({ visibilityModeKey, lastActiveKey }) => {
      localStorage.setItem(visibilityModeKey, "all");
      localStorage.setItem(lastActiveKey, String(Date.now()));
    },
    { visibilityModeKey: VISIBILITY_MODE_STORAGE_KEY, lastActiveKey: LAST_ACTIVE_STORAGE_KEY },
  );

  const allButton = page.getByRole("button", { name: "All", exact: true }).first();
  if (await allButton.isVisible().catch(() => false)) {
    await allButton.click();
  }
};

/**
 * Run fetch() inside the browser page context.
 * The browser handles cookies (including __Host-csrf) and Origin automatically.
 */
const browserFetch = async <T>(
  page: Page,
  path: string,
  method: "GET" | "POST",
  body: unknown | null,
): Promise<T> => {
  const result = await page.evaluate(
    async ({ url, method: m, body: b }) => {
      // Read __Host-csrf from document.cookie for the header
      const csrfMatch = document.cookie.match(/(?:^|;\s*)__Host-csrf=([0-9a-f]+)/);
      const csrfToken = csrfMatch !== null ? csrfMatch[1] : "";

      const headers: Record<string, string> = {};
      if (m === "POST") {
        headers["Content-Type"] = "application/json";
        if (csrfToken !== "") {
          headers["x-csrf-token"] = csrfToken;
        }
      }

      const res = await fetch(url, {
        method: m,
        headers,
        body: b !== null ? JSON.stringify(b) : undefined,
        credentials: "same-origin",
      });

      const text = await res.text();
      return { status: res.status, ok: res.ok, text };
    },
    { url: `${appBaseUrl}${path}`, method, body },
  );

  if (!result.ok) {
    throw new Error(`${method} ${path} failed: ${result.status} ${result.text}`);
  }

  return JSON.parse(result.text) as T;
};

type WorkspaceResult = Readonly<{
  workspaceId: string;
  name: string;
}>;

export const createTestWorkspace = async (
  page: Page,
  name: string,
): Promise<WorkspaceResult> =>
  browserFetch<WorkspaceResult>(page, "/api/workspaces", "POST", { name, timezone: "UTC" });

export const deleteTestWorkspace = async (
  page: Page,
  workspaceId: string,
  workspaceName: string,
): Promise<void> => {
  await browserFetch<unknown>(page, `/api/workspaces/${workspaceId}/delete`, "POST", { confirmText: workspaceName });
};

type TransactionResult = Readonly<{
  entryId: string;
  eventId: string;
  amount: number;
  currency: string;
  kind: string;
  category: string | null;
}>;

export const createTransaction = async (
  page: Page,
  data: Readonly<{
    ts: string;
    accountId: string;
    amount: number;
    currency: string;
    kind: "income" | "spend" | "transfer";
    category: string | null;
    counterparty: string | null;
    note: string | null;
  }>,
): Promise<TransactionResult> =>
  browserFetch<TransactionResult>(page, "/api/transactions/create", "POST", data);

type BalancesSummary = Readonly<{
  accounts: ReadonlyArray<Readonly<{
    accountId: string;
    currency: string;
    balance: number;
  }>>;
}>;

export const getBalancesSummary = async (
  page: Page,
): Promise<BalancesSummary> =>
  browserFetch<BalancesSummary>(page, "/api/balances-summary", "GET", null);

export const setBudgetPlan = async (
  page: Page,
  data: Readonly<{
    month: string;
    direction: "income" | "spend";
    category: string;
    kind: "base" | "modifier";
    plannedValue: number;
  }>,
): Promise<void> => {
  await browserFetch<unknown>(page, "/api/budget-plan", "POST", data);
};

type BudgetGridRow = Readonly<{
  month: string;
  direction: string;
  category: string;
  planned: number;
  actual: number;
}>;

type BudgetGrid = Readonly<{
  rows: ReadonlyArray<BudgetGridRow>;
}>;

export const getBudgetGrid = async (
  page: Page,
  monthFrom: string,
  monthTo: string,
  planFrom: string,
  actualTo: string,
): Promise<BudgetGrid> =>
  browserFetch<BudgetGrid>(
    page,
    `/api/budget-grid?monthFrom=${monthFrom}&monthTo=${monthTo}&planFrom=${planFrom}&actualTo=${actualTo}`,
    "GET",
    null,
  );

type TransactionsQuery = Readonly<{
  dateFrom: string;
  dateTo: string;
  accountId: string;
  sortKey: string;
  sortDir: "asc" | "desc";
  limit: number;
  offset: number;
}>;

type TransactionsPageResult = Readonly<{
  entries: ReadonlyArray<Readonly<{
    entryId: string;
    eventId: string;
    ts: string;
    accountId: string;
    amount: number;
    amountReport: number | null;
    currency: string;
    kind: string;
    category: string | null;
    counterparty: string | null;
    note: string | null;
  }>>;
  total: number;
}>;

export const getTransactionsPage = async (
  page: Page,
  query: TransactionsQuery,
): Promise<TransactionsPageResult> => {
  const params = new URLSearchParams({
    dateFrom: query.dateFrom,
    dateTo: query.dateTo,
    accountId: query.accountId,
    sortKey: query.sortKey,
    sortDir: query.sortDir,
    limit: String(query.limit),
    offset: String(query.offset),
  });

  return browserFetch<TransactionsPageResult>(
    page,
    `/api/transactions?${params.toString()}`,
    "GET",
    null,
  );
};

export const attachFailureDiagnostics = async (
  page: Page,
  testInfo: TestInfo,
  label: string,
): Promise<void> => {
  try {
    const screenshot = await page.screenshot({ fullPage: true });
    await testInfo.attach(`${label}-screenshot.png`, { body: screenshot, contentType: "image/png" });

    const html = await page.content();
    await testInfo.attach(`${label}-html.html`, { body: html, contentType: "text/html" });
  } catch {
    // best-effort diagnostics
  }
};
