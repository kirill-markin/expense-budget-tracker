/**
 * Shared helpers for the live smoke E2E tests.
 *
 * Provides auth bypass, workspace CRUD, and wrapped Playwright interactions
 * that attach diagnostic context on failure.
 */
import { expect, type Page, type TestInfo } from "@playwright/test";

const authBaseUrl = process.env.EXPENSE_E2E_AUTH_BASE_URL ?? "https://auth.expense-budget-tracker.com";
const reviewEmail = process.env.EXPENSE_E2E_REVIEW_EMAIL ?? "e2e-test@example.com";

export type LiveSmokeScenario = Readonly<{
  runId: string;
  workspaceName: string;
  testAccountId: string;
  testCategory: string;
}>;

export const runIdFromClock = (): string => String(Date.now());

export const buildScenario = (runId: string): LiveSmokeScenario => ({
  runId,
  workspaceName: `E2E web ${runId}`,
  testAccountId: `E2E Checking ${runId}`,
  testCategory: `E2E Groceries ${runId}`,
});

type DemoSignInResult = Readonly<{
  idToken: string;
  refreshToken: string;
}>;

export const signInWithDemoEmail = async (page: Page): Promise<DemoSignInResult> => {
  const response = await page.request.post(`${authBaseUrl}/api/send-code`, {
    data: { email: reviewEmail },
    headers: { "Content-Type": "application/json" },
    timeout: 30_000,
  });

  if (!response.ok()) {
    const text = await response.text();
    throw new Error(`Demo sign-in failed: ${response.status()} ${text}`);
  }

  const body = await response.json() as { ok: boolean; idToken: string; refreshToken: string };
  if (!body.ok || typeof body.idToken !== "string") {
    throw new Error(`Demo sign-in did not return tokens: ${JSON.stringify(body)}`);
  }

  return { idToken: body.idToken, refreshToken: body.refreshToken };
};

export const setSessionCookies = async (
  page: Page,
  baseUrl: string,
  tokens: DemoSignInResult,
): Promise<void> => {
  const url = new URL(baseUrl);
  const domain = url.hostname;

  await page.context().addCookies([
    { name: "session", value: tokens.idToken, domain, path: "/", httpOnly: true, secure: true, sameSite: "Lax" },
    { name: "refresh", value: tokens.refreshToken, domain, path: "/", httpOnly: true, secure: true, sameSite: "Lax" },
    { name: "logged_in", value: "1", domain, path: "/", httpOnly: false, secure: true, sameSite: "Lax" },
  ]);
};

type WorkspaceResult = Readonly<{
  workspaceId: string;
  name: string;
}>;

export const createTestWorkspace = async (
  page: Page,
  baseUrl: string,
  name: string,
): Promise<WorkspaceResult> => {
  const csrfCookie = await getCsrfCookie(page, baseUrl);
  const response = await page.request.post(`${baseUrl}/api/workspaces`, {
    data: { name, timezone: "UTC" },
    headers: {
      "Content-Type": "application/json",
      "x-csrf-token": csrfCookie,
    },
  });

  if (!response.ok()) {
    const text = await response.text();
    throw new Error(`Create workspace failed: ${response.status()} ${text}`);
  }

  return response.json() as Promise<WorkspaceResult>;
};

export const selectWorkspace = async (
  page: Page,
  baseUrl: string,
  workspaceId: string,
): Promise<void> => {
  const url = new URL(baseUrl);
  await page.context().addCookies([
    { name: "workspace", value: workspaceId, domain: url.hostname, path: "/", httpOnly: false, secure: true, sameSite: "Lax" },
  ]);
};

export const deleteTestWorkspace = async (
  page: Page,
  baseUrl: string,
  workspaceId: string,
  workspaceName: string,
): Promise<void> => {
  const csrfCookie = await getCsrfCookie(page, baseUrl);
  const response = await page.request.post(`${baseUrl}/api/workspaces/${workspaceId}/delete`, {
    data: { confirmText: workspaceName },
    headers: {
      "Content-Type": "application/json",
      "x-csrf-token": csrfCookie,
    },
  });

  if (!response.ok()) {
    const text = await response.text();
    throw new Error(`Delete workspace failed: ${response.status()} ${text}`);
  }
};

const getCsrfCookie = async (page: Page, baseUrl: string): Promise<string> => {
  const url = new URL(baseUrl);
  const cookies = await page.context().cookies(baseUrl);
  const csrf = cookies.find((c) => c.name === "__Host-csrf");
  if (csrf !== undefined) {
    return csrf.value;
  }

  // Navigate to get the CSRF cookie set by the proxy
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  const freshCookies = await page.context().cookies(baseUrl);
  const freshCsrf = freshCookies.find((c) => c.name === "__Host-csrf");
  if (freshCsrf === undefined) {
    throw new Error(`No __Host-csrf cookie found for ${url.hostname}`);
  }
  return freshCsrf.value;
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
  baseUrl: string,
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
): Promise<TransactionResult> => {
  const csrfCookie = await getCsrfCookie(page, baseUrl);
  const response = await page.request.post(`${baseUrl}/api/transactions/create`, {
    data,
    headers: {
      "Content-Type": "application/json",
      "x-csrf-token": csrfCookie,
    },
  });

  if (!response.ok()) {
    const text = await response.text();
    throw new Error(`Create transaction failed: ${response.status()} ${text}`);
  }

  return response.json() as Promise<TransactionResult>;
};

type BalancesSummary = Readonly<{
  accounts: ReadonlyArray<Readonly<{
    accountId: string;
    currency: string;
    balance: number;
  }>>;
}>;

export const getBalancesSummary = async (
  page: Page,
  baseUrl: string,
): Promise<BalancesSummary> => {
  const response = await page.request.get(`${baseUrl}/api/balances-summary`);

  if (!response.ok()) {
    const text = await response.text();
    throw new Error(`Balances summary failed: ${response.status()} ${text}`);
  }

  return response.json() as Promise<BalancesSummary>;
};

export const setBudgetPlan = async (
  page: Page,
  baseUrl: string,
  data: Readonly<{
    month: string;
    direction: "income" | "spend";
    category: string;
    kind: "base" | "modifier";
    plannedValue: number;
  }>,
): Promise<void> => {
  const csrfCookie = await getCsrfCookie(page, baseUrl);
  const response = await page.request.post(`${baseUrl}/api/budget-plan`, {
    data,
    headers: {
      "Content-Type": "application/json",
      "x-csrf-token": csrfCookie,
    },
  });

  if (!response.ok()) {
    const text = await response.text();
    throw new Error(`Set budget plan failed: ${response.status()} ${text}`);
  }
};

type BudgetGridRow = Readonly<{
  direction: string;
  category: string;
  months: ReadonlyArray<Readonly<{
    month: string;
    planned: number;
    actual: number;
  }>>;
}>;

type BudgetGrid = Readonly<{
  rows: ReadonlyArray<BudgetGridRow>;
}>;

export const getBudgetGrid = async (
  page: Page,
  baseUrl: string,
  monthFrom: string,
  monthTo: string,
): Promise<BudgetGrid> => {
  const response = await page.request.get(
    `${baseUrl}/api/budget-grid?monthFrom=${monthFrom}&monthTo=${monthTo}`,
  );

  if (!response.ok()) {
    const text = await response.text();
    throw new Error(`Budget grid failed: ${response.status()} ${text}`);
  }

  return response.json() as Promise<BudgetGrid>;
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
