/**
 * Live smoke tests for the Expense Budget Tracker.
 *
 * Happy-path coverage: auth → workspace → transactions → balances → budget → AI chat → cleanup.
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
  ensureAllVisibilityMode,
  getBalancesSummary,
  getBudgetGrid,
  getTransactionsPage,
  runIdFromClock,
  setBudgetPlan,
  setWorkspaceCookie,
  setupBrowserSession,
  signInWithDemoEmail,
  type LiveSmokeScenario,
} from "./live-smoke.actions";

const externalUiTimeoutMs = 30_000;
const chatCompletionTimeoutMs = 90_000;

type CompletedLedgerInsertToolCall = Readonly<{
  summary: string;
  input: string;
  output: string;
}>;

type TransactionsPageResult = Awaited<ReturnType<typeof getTransactionsPage>>;
type TransactionEntry = TransactionsPageResult["entries"][number];

test.describe.serial("live smoke: auth, transactions, balances, budget, and AI chat", () => {
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
    if (sharedPage !== null && createdWorkspaceId !== null && sharedScenario !== null) {
      try {
        await deleteTestWorkspace(sharedPage, createdWorkspaceId, sharedScenario.workspaceName);
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
      const tokens = await signInWithDemoEmail();
      await setupBrowserSession(page, tokens);

      const workspace = await createTestWorkspace(page, scenario.workspaceName);
      createdWorkspaceId = workspace.workspaceId;
      expect(workspace.name).toBe(scenario.workspaceName);

      await setWorkspaceCookie(page, workspace.workspaceId);

      // Reload with workspace cookie set
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      await expect(page).not.toHaveURL(/\/login/);
      await ensureAllVisibilityMode(page);
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
      const income = await createTransaction(page, {
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

      const expense = await createTransaction(page, {
        ts: now,
        accountId: scenario.testAccountId,
        amount: -250,
        currency: "USD",
        kind: "spend",
        category: scenario.testCategory,
        counterparty: "Test Store",
        note: `E2E expense ${scenario.runId}`,
      });
      expect(expense.entryId).toBeTruthy();
      expect(expense.amount).toBe(-250);

      const summary = await getBalancesSummary(page);
      const testAccount = summary.accounts.find((a) => a.accountId === scenario.testAccountId);
      expect(testAccount).toBeDefined();
      expect(testAccount!.balance).toBe(750);
      expect(testAccount!.currency).toBe("USD");

      await page.goto(`${baseUrl}/transactions`, { waitUntil: "domcontentloaded" });
      await ensureAllVisibilityMode(page);
      await expect(page.locator("main").getByRole("table").first()).toContainText(scenario.testAccountId, { timeout: externalUiTimeoutMs });
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
      await setBudgetPlan(page, {
        month: currentMonth,
        direction: "spend",
        category: scenario.testCategory,
        kind: "base",
        plannedValue: 500,
      });

      const grid = await getBudgetGrid(page, currentMonth, currentMonth, currentMonth, currentMonth);
      const row = grid.rows.find(
        (r) => r.month === currentMonth
          && r.category === scenario.testCategory
          && r.direction === "spend",
      );
      expect(row).toBeDefined();
      expect(row!.planned).toBe(500);
      expect(row!.actual).toBe(250);

      await page.goto(`${baseUrl}/budget`, { waitUntil: "domcontentloaded" });
      await ensureAllVisibilityMode(page);
      await expect(page.locator("main").getByRole("table").first()).toContainText(scenario.testCategory, { timeout: externalUiTimeoutMs });
    } catch (error) {
      await attachFailureDiagnostics(page, testInfo, "budget-grid");
      throw error;
    }
  });

  test("create transaction through sidebar AI chat and verify it appears in transactions", async ({}, testInfo) => {
    const page = sharedPage!;
    const baseUrl = sharedBaseUrl!;
    const scenario = sharedScenario!;

    try {
      await page.goto(`${baseUrl}/transactions`, { waitUntil: "domcontentloaded" });
      await ensureAllVisibilityMode(page);
      await ensureSidebarChatOpen(page);

      const insertToolCall = await createTransactionThroughAiChat(page, scenario);
      expect(insertToolCall.input).toContain("INSERT INTO ledger_entries");
      expect(insertToolCall.output).toContain("\"ok\": true");

      const insertedEntry = await waitForAiTransactionInApi(page, scenario);
      expect(insertedEntry.accountId).toBe(scenario.testAccountId);
      expect(insertedEntry.amount).toBe(scenario.aiTransactionAmount);
      expect(insertedEntry.category).toBe(scenario.testCategory);
      expect(insertedEntry.counterparty).toBe(scenario.aiTransactionCounterparty);
      expect(insertedEntry.note).toBe(scenario.aiTransactionNote);

      await expect.poll(
        async () => {
          const tableText = await page.locator("table").first().textContent();
          return tableText ?? "";
        },
        { timeout: externalUiTimeoutMs },
      ).toContain(scenario.aiTransactionNote);
    } catch (error) {
      await attachFailureDiagnostics(page, testInfo, "transactions-ai-chat");
      throw error;
    }
  });
});

function getDateOffsetIso(
  isoTimestamp: string,
  offsetDays: number,
): string {
  const date = new Date(isoTimestamp);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

async function ensureSidebarChatOpen(page: Page): Promise<void> {
  const messageField = page.getByPlaceholder("Type a message...");
  if (await messageField.isVisible().catch(() => false)) {
    return;
  }

  await page.getByRole("button", { name: "AI Chat", exact: true }).click();
  await expect(messageField).toBeVisible({ timeout: externalUiTimeoutMs });
}

async function sendChatMessageAndWaitForIdle(
  page: Page,
  message: string,
): Promise<void> {
  const messageField = page.getByPlaceholder("Type a message...");
  const sendButton = page.getByRole("button", { name: "Send", exact: true });

  await expect(messageField).toBeVisible({ timeout: externalUiTimeoutMs });
  await expect(sendButton).toBeVisible({ timeout: externalUiTimeoutMs });

  await messageField.fill(message);
  await expect(sendButton).toBeEnabled({ timeout: externalUiTimeoutMs });
  await sendButton.click();

  await expect(messageField).toHaveValue("", { timeout: externalUiTimeoutMs });
  await expect.poll(
    async () => {
      const stopVisible = await page.getByRole("button", { name: "Stop", exact: true }).isVisible().catch(() => false);
      if (stopVisible) {
        return "running";
      }

      const sendVisible = await sendButton.isVisible().catch(() => false);
      if (!sendVisible) {
        return "pending";
      }

      const sendEnabled = await sendButton.isEnabled().catch(() => false);
      return sendEnabled ? "draft" : "idle";
    },
    { timeout: chatCompletionTimeoutMs },
  ).toBe("idle");
}

async function readLedgerInsertToolCalls(
  page: Page,
): Promise<ReadonlyArray<CompletedLedgerInsertToolCall>> {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll("details"))
      .map((detail) => {
        const summary = detail.querySelector("summary")?.textContent?.trim() ?? "";
        const blocks = Array.from(detail.querySelectorAll("pre"))
          .map((block) => block.textContent?.trim() ?? "")
          .filter((block) => block.length > 0);

        return {
          summary,
          input: blocks[0] ?? "",
          output: blocks[1] ?? "",
        };
      })
      .filter((toolCall) => toolCall.input.includes("INSERT INTO ledger_entries"));
  });
}

async function findCompletedLedgerInsertToolCall(
  page: Page,
): Promise<CompletedLedgerInsertToolCall | null> {
  const toolCalls = await readLedgerInsertToolCalls(page);
  for (const toolCall of toolCalls) {
    if (!toolCall.output.includes("\"ok\": true") && !toolCall.output.includes("\"ok\":true")) {
      continue;
    }

    return toolCall;
  }

  return null;
}

async function waitForCompletedLedgerInsertToolCall(
  page: Page,
  timeoutMs: number,
): Promise<CompletedLedgerInsertToolCall | null> {
  const timeoutAt = Date.now() + timeoutMs;
  let matchedToolCall = await findCompletedLedgerInsertToolCall(page);

  while (matchedToolCall === null && Date.now() < timeoutAt) {
    await page.waitForTimeout(250);
    matchedToolCall = await findCompletedLedgerInsertToolCall(page);
  }

  return matchedToolCall;
}

async function createTransactionThroughAiChat(
  page: Page,
  scenario: LiveSmokeScenario,
): Promise<CompletedLedgerInsertToolCall> {
  const initialPrompt = [
    "Please add one spend transaction to the current workspace.",
    `Timestamp: ${scenario.aiTransactionTimestamp}`,
    `Account: ${scenario.testAccountId}`,
    `Amount: ${String(scenario.aiTransactionAmount)} USD`,
    `Category: ${scenario.testCategory}`,
    `Counterparty: ${scenario.aiTransactionCounterparty}`,
    `Note: ${scenario.aiTransactionNote}`,
    "This is a test transaction.",
    "Use best judgment for anything minor.",
    "Do not insert it yet if you still need explicit approval. I will confirm in my next message.",
  ].join("\n");

  const followUpPrompts: ReadonlyArray<string> = [
    "Confirmed. I approve this exact transaction and give you all permissions. Please execute it now.",
    "Continue. You already have my approval and can use best judgment. Execute the approved insert now.",
    "This is a test. Insert the approved transaction now and finish verification.",
  ];

  await sendChatMessageAndWaitForIdle(page, initialPrompt);

  const preApprovalInsert = await findCompletedLedgerInsertToolCall(page);
  if (preApprovalInsert !== null) {
    throw new Error("AI chat inserted a transaction before receiving explicit approval.");
  }

  for (const prompt of followUpPrompts) {
    await sendChatMessageAndWaitForIdle(page, prompt);
    const completedInsert = await waitForCompletedLedgerInsertToolCall(page, 30_000);
    if (completedInsert !== null) {
      return completedInsert;
    }
  }

  const observedToolCalls = await readLedgerInsertToolCalls(page);
  throw new Error(
    "AI chat did not complete a ledger insert after approval. "
    + `Observed insert tool calls: ${JSON.stringify(observedToolCalls)}`,
  );
}

async function waitForAiTransactionInApi(
  page: Page,
  scenario: LiveSmokeScenario,
): Promise<TransactionEntry> {
  const dateFrom = getDateOffsetIso(scenario.aiTransactionTimestamp, -1);
  const dateTo = getDateOffsetIso(scenario.aiTransactionTimestamp, 1);
  const timeoutAt = Date.now() + externalUiTimeoutMs;
  let lastEntries: ReadonlyArray<TransactionEntry> = [];

  while (Date.now() < timeoutAt) {
    const transactionsPage = await getTransactionsPage(page, {
      dateFrom,
      dateTo,
      accountId: scenario.testAccountId,
      sortKey: "ts",
      sortDir: "desc",
      limit: 100,
      offset: 0,
    });
    lastEntries = transactionsPage.entries;

    const matchingEntry = transactionsPage.entries.find((entry) =>
      entry.accountId === scenario.testAccountId
      && entry.amount === scenario.aiTransactionAmount
      && entry.category === scenario.testCategory
      && entry.counterparty === scenario.aiTransactionCounterparty
      && entry.note === scenario.aiTransactionNote);

    if (matchingEntry !== undefined) {
      return matchingEntry;
    }

    await page.waitForTimeout(500);
  }

  throw new Error(
    "Inserted AI transaction did not appear in /api/transactions before timeout. "
    + `Recent entries: ${JSON.stringify(lastEntries)}`,
  );
}
