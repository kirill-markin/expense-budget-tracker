/**
 * Scheduled cleanup of stale E2E test workspaces.
 *
 * Uses the same demo email bypass as the live smoke tests to authenticate,
 * lists workspaces via the web API, and deletes any with the configured
 * prefix that are older than the TTL. A second pass revokes agent API keys
 * the post-deploy smoke left behind when it was killed before its own
 * revocation.
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
// Deterministic label prefix scripts/live-agent-api-smoke.mjs mints its key
// with; like the workspace prefix, it is a literal duplicated in both files.
const agentKeyLabelPrefix = "agent-api-smoke-";
// Plausibility window for a trailing workspace-name token read as a
// millisecond epoch. Not every E2E name ends in a clock reading: the agent API
// smoke ends its name with a GitHub run id, which is an 11-digit number that
// parses to 1971 and would otherwise look stale the instant the workspace is
// created. Deletion is destructive and racing a running deploy, so an age this
// script cannot prove means skip: an extra workspace survives to the next run,
// while a wrong delete fails a smoke whose own checks passed.
const nameTimestampFloorMs = Date.UTC(2024, 0, 1);
const nameTimestampClockSkewMs = 5 * 60 * 1_000;

async function main() {
  const failures = [];
  const skipped = [];

  for (const email of reviewEmails) {
    let idToken = null;
    try {
      idToken = await signInWithDemoEmail(email);
    } catch (error) {
      failures.push(`email=${email} pass=sign_in: ${getErrorMessage(error)}`);
      continue;
    }

    try {
      let workspaceCookie = await resolveWorkspaceCookie(idToken);
      const workspaces = await listWorkspaces(idToken, workspaceCookie);
      const staleWorkspaces = workspaces.filter((w) => classifyWorkspace(w) === "delete");
      const unageableWorkspaces = workspaces.filter((w) => classifyWorkspace(w) === "unageable");

      console.log(
        `[cleanup] email=${email} workspaces=${workspaces.length} stale=${staleWorkspaces.length} unageable=${unageableWorkspaces.length}`,
      );

      for (const workspace of unageableWorkspaces) {
        skipped.push(
          `name=${workspace.name} id=${workspace.workspaceId}: age is not provable from the workspace name; delete by hand only after confirming no run owns it`,
        );
      }

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
      failures.push(`email=${email} pass=workspaces: ${getErrorMessage(error)}`);
    }

    // A leftover credential is the security-relevant half of the cleanup, so
    // this pass resolves its own workspace cookie and reports its own failure
    // even when the workspace pass above failed. It shares the sign-in above,
    // so a sign-in failure skips the email before either pass runs.
    try {
      const workspaceCookie = await resolveWorkspaceCookie(idToken);
      const connections = await listAgentConnections(idToken, workspaceCookie);
      const staleConnections = connections.filter((c) => shouldRevokeConnection(c));

      console.log(`[cleanup] email=${email} connections=${connections.length} stale_connections=${staleConnections.length}`);

      for (const connection of staleConnections) {
        try {
          await revokeAgentConnection(idToken, workspaceCookie, connection);
        } catch (error) {
          failures.push(
            `email=${email} pass=agent_keys connection=${connection.connectionId}: ${getErrorMessage(error)}`,
          );
        }
      }
    } catch (error) {
      failures.push(`email=${email} pass=agent_keys: ${getErrorMessage(error)}`);
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

/**
 * "delete" when the name carries the prefix and a timestamp proving the TTL has
 * passed, "unageable" when it carries the prefix but no provable age, so the
 * run can name what it refused to age, and "keep" for everything else.
 */
function classifyWorkspace(workspace) {
  if (typeof workspace.name !== "string" || !workspace.name.startsWith(workspacePrefix)) {
    return "keep";
  }

  const timestampMs = parseNameTimestampMs(workspace.name);
  if (timestampMs === null) {
    return "unageable";
  }

  return hoursSince(timestampMs) >= ttlHours ? "delete" : "keep";
}

/**
 * Reads the trailing token of a workspace name as a millisecond epoch
 * ("E2E web 1234567890"), and returns null when the value is not plausibly a
 * recent one.
 */
function parseNameTimestampMs(name) {
  const parts = name.split(" ");
  const timestampMs = Number.parseInt(parts[parts.length - 1], 10);

  if (Number.isNaN(timestampMs)) {
    return null;
  }

  if (timestampMs < nameTimestampFloorMs || timestampMs > Date.now() + nameTimestampClockSkewMs) {
    return null;
  }

  return timestampMs;
}

function hoursSince(timestampMs) {
  return (Date.now() - timestampMs) / (60 * 60 * 1_000);
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

async function listAgentConnections(idToken, workspaceCookie) {
  const url = `${appBaseUrl}/api/agent-connections`;
  const response = await fetchWithRetry(url, {
    method: "GET",
    headers: buildAuthHeaders(idToken, workspaceCookie),
    redirect: "manual",
  }, "list_agent_connections");

  if (response.status === 307 || response.status === 302) {
    throw new Error(`Agent connection list redirected: url=${url} location=${response.headers.get("location") ?? ""}`);
  }

  const payload = await readJsonResponse(response, "Agent connection list");

  if (!response.ok) {
    throw new Error(`Agent connection list failed: url=${url} status=${response.status} body=${formatPayload(payload)}`);
  }

  if (!Array.isArray(payload.connections)) {
    throw new Error(`Agent connection list payload has no connections array: ${formatPayload(payload)}`);
  }

  return payload.connections;
}

/**
 * A key is reclaimable only when the smoke demonstrably failed to revoke its
 * own: it carries the smoke's label, is still active, and has outlived the
 * workspace TTL, so a key minted by a deploy running right now is never taken.
 */
function shouldRevokeConnection(connection) {
  // The list is a tagged union of API-key and OAuth rows, where an OAuth row's
  // label is its client-supplied client_name; the revoke endpoint below handles
  // api_key rows only.
  if (connection.type !== "api_key") {
    return false;
  }

  if (typeof connection.label !== "string") {
    throw new Error(`Agent connection ${JSON.stringify(connection)} is missing label`);
  }

  if (!connection.label.startsWith(agentKeyLabelPrefix)) {
    return false;
  }

  if (connection.revokedAt !== null && connection.revokedAt !== undefined) {
    return false;
  }

  if (typeof connection.createdAt !== "string") {
    throw new Error(`Agent connection ${JSON.stringify(connection)} is missing createdAt`);
  }

  const createdAtMs = Date.parse(connection.createdAt);
  if (Number.isNaN(createdAtMs)) {
    throw new Error(`Agent connection ${JSON.stringify(connection)} has an unparseable createdAt`);
  }

  return hoursSince(createdAtMs) >= ttlHours;
}

async function revokeAgentConnection(idToken, workspaceCookie, connection) {
  if (typeof connection.connectionId !== "string" || connection.connectionId === "") {
    throw new Error(`Agent connection ${JSON.stringify(connection)} is missing connectionId`);
  }

  const url = `${appBaseUrl}/api/agent-connections/${connection.connectionId}/revoke`;
  const response = await fetchWithRetry(url, {
    method: "POST",
    headers: buildAuthHeaders(idToken, workspaceCookie),
  }, `revoke_agent_connection id=${connection.connectionId}`);

  const payload = await readJsonResponse(response, "Agent connection revoke");

  if (!response.ok) {
    throw new Error(`Revoke agent connection failed: id=${connection.connectionId} url=${url} status=${response.status} body=${formatPayload(payload)}`);
  }

  if (payload.revoked !== true) {
    throw new Error(`Revoke agent connection did not revoke: id=${connection.connectionId} url=${url} body=${formatPayload(payload)}`);
  }

  console.log(`[cleanup] revoked connection label=${connection.label} id=${connection.connectionId}`);
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
