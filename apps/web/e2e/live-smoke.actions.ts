/**
 * Shared helpers for the live smoke E2E tests.
 *
 * Provides auth bypass, workspace CRUD, and wrapped Playwright interactions
 * that attach diagnostic context on failure.
 *
 * All API calls use Node.js native fetch with explicit Cookie headers.
 * Playwright's page.request merges cookies from its jar, which breaks
 * __Host- prefixed cookies (the jar stores them with a Domain attribute
 * that violates the __Host- prefix contract).
 */
import { randomBytes } from "node:crypto";
import { type Page, type TestInfo } from "@playwright/test";

const authBaseUrl = process.env.EXPENSE_E2E_AUTH_BASE_URL ?? "https://auth.expense-budget-tracker.com";
const appBaseUrl = process.env.EXPENSE_E2E_APP_BASE_URL ?? "https://app.expense-budget-tracker.com";
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
  "Origin": appBaseUrl,
});

const buildReadHeaders = (session: SessionState): Record<string, string> => ({
  "Cookie": buildCookieHeader(session),
});

const assertOk = async (response: Response, label: string): Promise<void> => {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${label} failed: ${response.status} ${text}`);
  }
};

type DemoSignInResult = Readonly<{
  idToken: string;
  refreshToken: string;
}>;

export const signInWithDemoEmail = async (): Promise<DemoSignInResult> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch(`${authBaseUrl}/api/send-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: reviewEmail }),
      signal: controller.signal,
    });

    await assertOk(response, "Demo sign-in");

    const body = await response.json() as { ok: boolean; idToken: string; refreshToken: string };
    if (!body.ok || typeof body.idToken !== "string") {
      throw new Error(`Demo sign-in did not return tokens: ${JSON.stringify(body)}`);
    }

    return { idToken: body.idToken, refreshToken: body.refreshToken };
  } finally {
    clearTimeout(timeout);
  }
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
  session: SessionState,
  name: string,
): Promise<WorkspaceResult> => {
  const response = await fetch(`${appBaseUrl}/api/workspaces`, {
    method: "POST",
    headers: buildMutatingHeaders(session),
    body: JSON.stringify({ name, timezone: "UTC" }),
  });

  await assertOk(response, "Create workspace");
  return response.json() as Promise<WorkspaceResult>;
};

export const deleteTestWorkspace = async (
  session: SessionState,
  workspaceName: string,
): Promise<void> => {
  const response = await fetch(`${appBaseUrl}/api/workspaces/${session.workspaceId}/delete`, {
    method: "POST",
    headers: buildMutatingHeaders(session),
    body: JSON.stringify({ confirmText: workspaceName }),
  });

  await assertOk(response, "Delete workspace");
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
  const response = await fetch(`${appBaseUrl}/api/transactions/create`, {
    method: "POST",
    headers: buildMutatingHeaders(session),
    body: JSON.stringify(data),
  });

  await assertOk(response, "Create transaction");
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
  session: SessionState,
): Promise<BalancesSummary> => {
  const response = await fetch(`${appBaseUrl}/api/balances-summary`, {
    method: "GET",
    headers: buildReadHeaders(session),
  });

  await assertOk(response, "Balances summary");
  return response.json() as Promise<BalancesSummary>;
};

export const setBudgetPlan = async (
  session: SessionState,
  data: Readonly<{
    month: string;
    direction: "income" | "spend";
    category: string;
    kind: "base" | "modifier";
    plannedValue: number;
  }>,
): Promise<void> => {
  const response = await fetch(`${appBaseUrl}/api/budget-plan`, {
    method: "POST",
    headers: buildMutatingHeaders(session),
    body: JSON.stringify(data),
  });

  await assertOk(response, "Set budget plan");
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
  session: SessionState,
  monthFrom: string,
  monthTo: string,
): Promise<BudgetGrid> => {
  const response = await fetch(
    `${appBaseUrl}/api/budget-grid?monthFrom=${monthFrom}&monthTo=${monthTo}`,
    { method: "GET", headers: buildReadHeaders(session) },
  );

  await assertOk(response, "Budget grid");
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
