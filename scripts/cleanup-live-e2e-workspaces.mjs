/**
 * Scheduled cleanup of stale E2E test workspaces.
 *
 * Uses the same demo email bypass as the live smoke tests to authenticate,
 * lists workspaces via the web API, and deletes any with the configured
 * prefix that are older than the TTL.
 */
import { randomBytes } from "node:crypto";

const authBaseUrl = process.env.EXPENSE_LIVE_E2E_AUTH_BASE_URL ?? "https://auth.expense-budget-tracker.com";
const appBaseUrl = process.env.EXPENSE_LIVE_E2E_APP_BASE_URL ?? "https://expense-budget-tracker.com";
const workspacePrefix = process.env.EXPENSE_LIVE_E2E_WORKSPACE_PREFIX ?? "E2E ";
const ttlHours = parsePositiveInteger(
  process.env.EXPENSE_LIVE_E2E_WORKSPACE_TTL_HOURS ?? "48",
  "EXPENSE_LIVE_E2E_WORKSPACE_TTL_HOURS",
);
const reviewEmails = parseReviewEmails(
  process.env.EXPENSE_LIVE_E2E_REVIEW_EMAILS ?? "e2e-test@example.com",
);

async function main() {
  const failures = [];

  for (const email of reviewEmails) {
    try {
      const idToken = await signInWithDemoEmail(email);
      const workspaces = await listWorkspaces(idToken);
      const staleWorkspaces = workspaces.filter((w) => shouldDeleteWorkspace(w));

      console.log(`[cleanup] email=${email} workspaces=${workspaces.length} stale=${staleWorkspaces.length}`);

      for (const workspace of staleWorkspaces) {
        await deleteWorkspace(idToken, workspace);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`email=${email}: ${message}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Live E2E cleanup failed:\n${failures.join("\n")}`);
  }
}

function parsePositiveInteger(rawValue, envName) {
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${envName} must be a positive integer, received "${rawValue}"`);
  }
  return parsed;
}

function parseReviewEmails(rawValue) {
  const emails = rawValue
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter((v) => v !== "");

  if (emails.length === 0) {
    throw new Error("EXPENSE_LIVE_E2E_REVIEW_EMAILS must contain at least one email");
  }
  return emails;
}

async function signInWithDemoEmail(email) {
  const response = await fetch(`${authBaseUrl}/api/send-code`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const payload = await readJson(response);

  if (!response.ok) {
    throw new Error(`Demo sign-in failed for ${email}: status=${response.status} body=${JSON.stringify(payload)}`);
  }

  if (typeof payload.idToken !== "string" || payload.idToken === "") {
    throw new Error(`Demo sign-in did not return idToken for ${email}`);
  }

  return payload.idToken;
}

function generateCsrfToken() {
  return randomBytes(32).toString("hex");
}

function buildAuthHeaders(idToken, workspaceId) {
  const csrf = generateCsrfToken();
  const cookies = [`session=${idToken}`, `__Host-csrf=${csrf}`];
  if (workspaceId !== undefined) {
    cookies.push(`workspace=${workspaceId}`);
  }
  return {
    cookie: cookies.join("; "),
    "x-csrf-token": csrf,
  };
}

async function listWorkspaces(idToken) {
  const response = await fetch(`${appBaseUrl}/api/workspaces`, {
    method: "GET",
    headers: buildAuthHeaders(idToken),
  });

  if (response.status === 307 || response.status === 302) {
    throw new Error("Workspace list redirected — session cookie may not be accepted");
  }

  const payload = await readJson(response);

  if (!response.ok) {
    throw new Error(`Workspace list failed: status=${response.status} body=${JSON.stringify(payload)}`);
  }

  if (!Array.isArray(payload)) {
    throw new Error(`Workspace list payload is not an array: ${JSON.stringify(payload)}`);
  }

  return payload;
}

function shouldDeleteWorkspace(workspace) {
  if (typeof workspace.name !== "string" || !workspace.name.startsWith(workspacePrefix)) {
    return false;
  }

  // Extract the timestamp from the workspace name: "E2E web 1234567890"
  const parts = workspace.name.split(" ");
  const lastPart = parts[parts.length - 1];
  const timestamp = Number.parseInt(lastPart, 10);

  if (Number.isNaN(timestamp)) {
    // Can't determine age — skip
    return false;
  }

  const ageHours = (Date.now() - timestamp) / (60 * 60 * 1000);
  return ageHours >= ttlHours;
}

async function deleteWorkspace(idToken, workspace) {
  if (typeof workspace.workspaceId !== "string" || workspace.workspaceId === "") {
    throw new Error(`Workspace ${JSON.stringify(workspace)} is missing workspaceId`);
  }

  const response = await fetch(`${appBaseUrl}/api/workspaces/${workspace.workspaceId}/delete`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...buildAuthHeaders(idToken, workspace.workspaceId),
    },
    body: JSON.stringify({ confirmText: workspace.name }),
  });

  if (!response.ok) {
    const payload = await readJson(response);
    throw new Error(`Delete workspace failed: id=${workspace.workspaceId} status=${response.status} body=${JSON.stringify(payload)}`);
  }

  console.log(`[cleanup] deleted workspace name=${workspace.name} id=${workspace.workspaceId}`);
}

async function readJson(response) {
  const text = await response.text();
  if (text === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Response is not valid JSON: status=${response.status} body=${text}`);
  }
}

await main();
