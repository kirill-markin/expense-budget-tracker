/**
 * Shared helpers for the live smoke E2E tests.
 *
 * Provides auth bypass, workspace CRUD, and wrapped Playwright interactions
 * that attach diagnostic context on failure.
 *
 * All mutating API calls build explicit Cookie headers to work around
 * Playwright not sending __Host- prefixed cookies from its cookie jar.
 */
import { randomBytes } from "node:crypto";
import { type Page, type TestInfo } from "@playwright/test";

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

/**
 * Holds session state for building explicit Cookie headers.
 * Playwright's cookie jar doesn't handle __Host- prefixed cookies.
 */
export type SessionState = {
  idToken: string;
  refreshToken: string;
  csrfToken: string;
  workspaceId: string | null;
};

export const createSessionState = (idToken: string, refreshToken: string): SessionState => ({
  idToken,
  refreshToken,
  csrfToken: randomBytes(32).toString("hex"),
  workspaceId: null,
});

const buildCookieHeader = (session: SessionState): string => {
  const parts = [
    `session=${session.idToken}`,
    `refresh=${session.refreshToken}`,
    `logged_in=1`,
    `__Host-csrf=${session.csrfToken}`,
  ];
  if (session.workspaceId !== null) {
    parts.push(`workspace=${session.workspaceId}`);
  }
  return parts.join("; ");
};

const buildMutatingHeaders = (session: SessionState): Record<string, string> => ({
  "Content-Type": "application/json",
  "Cookie": buildCookieHeader(session),
  "x-csrf-token": session.csrfToken,
});

const buildReadHeaders = (session: SessionState): Record<string, string> => ({
  "Cookie": buildCookieHeader(session),
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

export const setSessionCookiesForNavigation = async (
  page: Page,
  baseUrl: string,
  session: SessionState,
): Promise<void> => {
  const url = new URL(baseUrl);
  const domain = url.hostname;

  await page.context().addCookies([
    { name: "session", value: session.idToken, domain, path: "/", httpOnly: true, secure: true, sameSite: "Lax" },
    { name: "refresh", value: session.refreshToken, domain, path: "/", httpOnly: true, secure: true, sameSite: "Lax" },
    { name: "logged_in", value: "1", domain, path: "/", httpOnly: false, secure: true, sameSite: "Lax" },
    ...(session.workspaceId !== null ? [
      { name: "workspace", value: session.workspaceId, domain, path: "/", httpOnly: false, secure: true, sameSite: "Lax" as const },
    ] : []),
  ]);
};

type WorkspaceResult = Readonly<{
  workspaceId: string;
  name: string;
}>;

export const createTestWorkspace = async (
  page: Page,
  baseUrl: string,
  session: SessionState,
  name: string,
): Promise<WorkspaceResult> => {
  const response = await page.request.post(`${baseUrl}/api/workspaces`, {
    data: { name, timezone: "UTC" },
    headers: buildMutatingHeaders(session),
  });

  if (!response.ok()) {
    const text = await response.text();
    throw new Error(`Create workspace failed: ${response.status()} ${text}`);
  }

  return response.json() as Promise<WorkspaceResult>;
};

export const deleteTestWorkspace = async (
  page: Page,
  baseUrl: string,
  session: SessionState,
  workspaceName: string,
): Promise<void> => {
  const response = await page.request.post(`${baseUrl}/api/workspaces/${session.workspaceId}/delete`, {
    data: { confirmText: workspaceName },
    headers: buildMutatingHeaders(session),
  });

  if (!response.ok()) {
    const text = await response.text();
    throw new Error(`Delete workspace failed: ${response.status()} ${text}`);
  }
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
  session: SessionState,
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
  const response = await page.request.post(`${baseUrl}/api/transactions/create`, {
    data,
    headers: buildMutatingHeaders(session),
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
  session: SessionState,
): Promise<BalancesSummary> => {
  const response = await page.request.get(`${baseUrl}/api/balances-summary`, {
    headers: buildReadHeaders(session),
  });

  if (!response.ok()) {
    const text = await response.text();
    throw new Error(`Balances summary failed: ${response.status()} ${text}`);
  }

  return response.json() as Promise<BalancesSummary>;
};

export const setBudgetPlan = async (
  page: Page,
  baseUrl: string,
  session: SessionState,
  data: Readonly<{
    month: string;
    direction: "income" | "spend";
    category: string;
    kind: "base" | "modifier";
    plannedValue: number;
  }>,
): Promise<void> => {
  const response = await page.request.post(`${baseUrl}/api/budget-plan`, {
    data,
    headers: buildMutatingHeaders(session),
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
  session: SessionState,
  monthFrom: string,
  monthTo: string,
): Promise<BudgetGrid> => {
  const response = await page.request.get(
    `${baseUrl}/api/budget-grid?monthFrom=${monthFrom}&monthTo=${monthTo}`,
    { headers: buildReadHeaders(session) },
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
