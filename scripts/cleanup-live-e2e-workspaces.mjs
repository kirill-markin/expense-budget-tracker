/**
 * Scheduled cleanup of stale E2E test workspaces.
 *
 * Uses the same demo email bypass as the live smoke tests to authenticate,
 * lists workspaces via the web API, and deletes any with the configured
 * prefix that are older than the TTL.
 */
import { randomBytes } from "node:crypto";

const authBaseUrl = process.env.EXPENSE_LIVE_E2E_AUTH_BASE_URL ?? "https://auth.expense-budget-tracker.com";
const appBaseUrl = process.env.EXPENSE_LIVE_E2E_APP_BASE_URL ?? "https://app.expense-budget-tracker.com";
const workspacePrefix = process.env.EXPENSE_LIVE_E2E_WORKSPACE_PREFIX ?? "E2E ";
const workspaceBootstrapPath = "/api/workspaces/bootstrap?returnTo=%2Fapi%2Fworkspaces";
const ttlHours = parsePositiveInteger(
  process.env.EXPENSE_LIVE_E2E_WORKSPACE_TTL_HOURS ?? "48",
  "EXPENSE_LIVE_E2E_WORKSPACE_TTL_HOURS",
);
const reviewEmails = parseReviewEmails(
  process.env.EXPENSE_LIVE_E2E_REVIEW_EMAILS ?? "e2e-test@example.com",
);
const fetchRetryAttempts = 3;
const fetchRetryDelayMs = 1_000;
const workspaceDeleteRequiresSingleMemberMessage =
  "Workspace deletion is only allowed when the workspace has exactly one member;";

async function main() {
  const failures = [];
  const skipped = [];

  for (const email of reviewEmails) {
    try {
      const idToken = await signInWithDemoEmail(email);
      let workspaceCookie = await resolveWorkspaceCookie(idToken);
      const workspaces = await listWorkspaces(idToken, workspaceCookie);
      const staleWorkspaces = workspaces.filter((w) => shouldDeleteWorkspace(w));

      console.log(`[cleanup] email=${email} workspaces=${workspaces.length} stale=${staleWorkspaces.length}`);

      for (const workspace of staleWorkspaces) {
        try {
          await deleteWorkspace(idToken, workspaceCookie, workspace);
          if (workspace.workspaceId === workspaceCookie) {
            workspaceCookie = await resolveWorkspaceCookie(idToken);
          }
        } catch (error) {
          const message = getErrorMessage(error);
          if (message.includes(workspaceDeleteRequiresSingleMemberMessage)) {
            skipped.push(`${workspace.name}: ${message}`);
            console.warn(`[cleanup] skipped name=${workspace.name} id=${workspace.workspaceId} reason=${JSON.stringify(message)}`);
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      const message = getErrorMessage(error);
      failures.push(`email=${email}: ${message}`);
    }
  }

  if (skipped.length > 0) {
    console.warn(`[cleanup] skipped=${skipped.length}`);
    for (const entry of skipped) {
      console.warn(`[cleanup] skipped_detail=${JSON.stringify(entry)}`);
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
  const url = `${authBaseUrl}/api/send-code`;
  const response = await fetchWithRetry(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  }, `demo_sign_in email=${email}`);
  const payload = await readJsonResponse(response, "Demo sign-in");

  if (!response.ok) {
    throw new Error(`Demo sign-in failed for ${email}: url=${url} status=${response.status} body=${formatPayload(payload)}`);
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
    origin: appBaseUrl,
  };
}

async function resolveWorkspaceCookie(idToken) {
  const url = `${appBaseUrl}${workspaceBootstrapPath}`;
  const response = await fetchWithRetry(url, {
    method: "GET",
    headers: buildAuthHeaders(idToken),
    redirect: "manual",
  }, "workspace_bootstrap");

  const location = response.headers.get("location") ?? "";
  if (response.status !== 307 && response.status !== 302) {
    const payload = await readResponsePayload(response);
    throw new Error(
      `Workspace bootstrap failed: url=${url} status=${response.status} location=${location} body=${formatPayload(payload)}`,
    );
  }

  const workspaceCookie = readCookieFromHeader(response.headers.get("set-cookie"), "workspace");
  if (workspaceCookie === "") {
    throw new Error(`Workspace bootstrap did not return workspace cookie: url=${url} location=${location}`);
  }

  return workspaceCookie;
}

async function listWorkspaces(idToken, workspaceCookie) {
  const url = `${appBaseUrl}/api/workspaces`;
  const response = await fetchWithRetry(url, {
    method: "GET",
    headers: buildAuthHeaders(idToken, workspaceCookie),
    redirect: "manual",
  }, "list_workspaces");

  if (response.status === 307 || response.status === 302) {
    throw new Error(`Workspace list redirected: url=${url} location=${response.headers.get("location") ?? ""}`);
  }

  const payload = await readJsonResponse(response, "Workspace list");

  if (!response.ok) {
    throw new Error(`Workspace list failed: url=${url} status=${response.status} body=${formatPayload(payload)}`);
  }

  if (!Array.isArray(payload)) {
    throw new Error(`Workspace list payload is not an array: ${formatPayload(payload)}`);
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

async function deleteWorkspace(idToken, workspaceCookie, workspace) {
  if (typeof workspace.workspaceId !== "string" || workspace.workspaceId === "") {
    throw new Error(`Workspace ${JSON.stringify(workspace)} is missing workspaceId`);
  }

  const url = `${appBaseUrl}/api/workspaces/${workspace.workspaceId}/delete`;
  const response = await fetchWithRetry(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...buildAuthHeaders(idToken, workspaceCookie),
    },
    body: JSON.stringify({ confirmText: workspace.name }),
  }, `delete_workspace id=${workspace.workspaceId}`);

  if (!response.ok) {
    const payload = await readResponsePayload(response);
    throw new Error(`Delete workspace failed: id=${workspace.workspaceId} url=${url} status=${response.status} body=${formatPayload(payload)}`);
  }

  console.log(`[cleanup] deleted workspace name=${workspace.name} id=${workspace.workspaceId}`);
}

async function fetchWithRetry(url, options, label) {
  let lastError = null;

  for (let attempt = 1; attempt <= fetchRetryAttempts; attempt += 1) {
    try {
      const response = await fetch(url, options);
      if (response.status === 429 || response.status >= 500) {
        const payload = await readResponsePayload(response);
        const error = new Error(
          `${label} transient response: url=${url} status=${response.status} body=${formatPayload(payload)}`,
        );
        if (attempt === fetchRetryAttempts) {
          throw error;
        }
        lastError = error;
      } else {
        return response;
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt === fetchRetryAttempts) {
        break;
      }
    }

    console.warn(
      `[cleanup] retry label=${JSON.stringify(label)} attempt=${attempt}/${fetchRetryAttempts} url=${url} error=${JSON.stringify(getErrorMessage(lastError))}`,
    );
    await sleep(fetchRetryDelayMs * attempt);
  }

  throw new Error(`${label} failed after ${fetchRetryAttempts} attempts: ${getErrorMessage(lastError)}`);
}

async function sleep(delayMs) {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function readCookieFromHeader(headerValue, cookieName) {
  if (headerValue === null || headerValue === "") {
    return "";
  }

  const pattern = new RegExp(`(?:^|,\\s*)${cookieName}=([^;]+)`);
  const match = headerValue.match(pattern);
  return match === null ? "" : decodeURIComponent(match[1]);
}

async function readResponsePayload(response) {
  const text = await response.text();
  if (text === "") {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function readJsonResponse(response, label) {
  const payload = await readResponsePayload(response);
  if (typeof payload === "string") {
    throw new Error(`${label} response is not valid JSON: status=${response.status} body=${payload}`);
  }

  return payload;
}

function formatPayload(payload) {
  return typeof payload === "string" ? payload : JSON.stringify(payload);
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

await main();
