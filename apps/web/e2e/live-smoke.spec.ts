/**
 * Live smoke tests for the Expense Budget Tracker.
 *
 * Happy-path coverage: auth → workspace → transactions → balances → budget → cleanup.
 * Runs serially with a shared browser session and one ephemeral workspace per run.
 * Designed to run post-deploy against the real production environment.
 */
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import {
  attachFailureDiagnostics,
  buildScenario,
  createTestWorkspace,
  createTransaction,
  deleteTestWorkspace,
  getBalancesSummary,
  getBudgetGrid,
  runIdFromClock,
  selectWorkspace,
  setBudgetPlan,
  setSessionCookies,
  signInWithDemoEmail,
  type LiveSmokeScenario,
} from "./live-smoke.actions";

test.describe.serial("live smoke: auth, transactions, balances, and budget", () => {
  let sharedContext: BrowserContext | null = null;
  let sharedPage: Page | null = null;
  let sharedBaseUrl: string | null = null;
  let sharedScenario: LiveSmokeScenario | null = null;
  let createdWorkspaceId: string | null = null;

  test.beforeAll(async ({ browser, baseURL }) => {
    if (baseURL === undefined) {
      throw new Error("Playwright baseURL is required for the live smoke flow");
    }

    sharedBaseUrl = baseURL;
    sharedScenario = buildScenario(runIdFromClock());
    sharedContext = await browser.newContext({ ignoreHTTPSErrors: true });
    sharedPage = await sharedContext.newPage();
  });

  test.afterAll(async () => {
    if (sharedPage !== null && sharedBaseUrl !== null && createdWorkspaceId !== null && sharedScenario !== null) {
      try {
        await deleteTestWorkspace(sharedPage, sharedBaseUrl, createdWorkspaceId, sharedScenario.workspaceName);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[cleanup] Failed to delete workspace ${createdWorkspaceId}: ${message}`);
      }
    }

    if (sharedContext !== null) {
      await sharedContext.close();
    }
  });

  test("sign in with demo email and create test workspace", async ({}, testInfo) => {
    const page = sharedPage!;
    const baseUrl = sharedBaseUrl!;
    const scenario = sharedScenario!;

    try {
      const tokens = await signInWithDemoEmail(page);
      await setSessionCookies(page, baseUrl, tokens);

      const workspace = await createTestWorkspace(page, baseUrl, scenario.workspaceName);
      createdWorkspaceId = workspace.workspaceId;
      expect(workspace.name).toBe(scenario.workspaceName);

      await selectWorkspace(page, baseUrl, workspace.workspaceId);

      await page.goto(baseUrl, { waitUntil: "networkidle" });
      await expect(page).not.toHaveURL(/\/login/);
    } catch (error) {
      await attachFailureDiagnostics(page, testInfo, "auth-workspace-setup");
      throw error;
    }
  });

  test("create transactions and verify balances", async ({}, testInfo) => {
    const page = sharedPage!;
    const baseUrl = sharedBaseUrl!;
    const scenario = sharedScenario!;
    const now = new Date().toISOString();

    try {
      const income = await createTransaction(page, baseUrl, {
        ts: now,
        accountId: scenario.testAccountId,
        amount: 1000,
        currency: "USD",
        kind: "income",
        category: "Salary",
        counterparty: null,
        note: `E2E income ${scenario.runId}`,
      });
      expect(income.entryId).toBeTruthy();
      expect(income.amount).toBe(1000);

      const expense = await createTransaction(page, baseUrl, {
        ts: now,
        accountId: scenario.testAccountId,
        amount: 250,
        currency: "USD",
        kind: "spend",
        category: scenario.testCategory,
        counterparty: "Test Store",
        note: `E2E expense ${scenario.runId}`,
      });
      expect(expense.entryId).toBeTruthy();
      expect(expense.amount).toBe(250);

      const summary = await getBalancesSummary(page, baseUrl);
      const testAccount = summary.accounts.find((a) => a.accountId === scenario.testAccountId);
      expect(testAccount).toBeDefined();
      expect(testAccount!.balance).toBe(750);
      expect(testAccount!.currency).toBe("USD");

      await page.goto(`${baseUrl}/transactions`, { waitUntil: "networkidle" });
      await expect(page.locator("body")).toContainText(scenario.testAccountId);
    } catch (error) {
      await attachFailureDiagnostics(page, testInfo, "transactions-balances");
      throw error;
    }
  });

  test("set budget plan and verify grid", async ({}, testInfo) => {
    const page = sharedPage!;
    const baseUrl = sharedBaseUrl!;
    const scenario = sharedScenario!;
    const currentMonth = new Date().toISOString().slice(0, 7);

    try {
      await setBudgetPlan(page, baseUrl, {
        month: currentMonth,
        direction: "spend",
        category: scenario.testCategory,
        kind: "base",
        plannedValue: 500,
      });

      const grid = await getBudgetGrid(page, baseUrl, currentMonth, currentMonth);
      const row = grid.rows.find(
        (r) => r.category === scenario.testCategory && r.direction === "spend",
      );
      expect(row).toBeDefined();

      const monthData = row!.months.find((m) => m.month === currentMonth);
      expect(monthData).toBeDefined();
      expect(monthData!.planned).toBe(500);
      expect(monthData!.actual).toBe(250);

      await page.goto(`${baseUrl}/budget`, { waitUntil: "networkidle" });
      await expect(page.locator("body")).toContainText(scenario.testCategory);
    } catch (error) {
      await attachFailureDiagnostics(page, testInfo, "budget-grid");
      throw error;
    }
  });
});
