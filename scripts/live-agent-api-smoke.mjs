/**
 * Post-deploy smoke for the public agent API contract.
 *
 * Validates every endpoint published in api/openapi.yaml using the shared
 * review email path, then cleans up the disposable workspace via the web app.
 */
import { randomBytes } from "node:crypto";

const authBaseUrl = trimTrailingSlash(
  process.env.EXPENSE_AGENT_SMOKE_AUTH_BASE_URL ?? "https://auth.expense-budget-tracker.com",
);
const apiBaseUrl = trimTrailingSlash(
  process.env.EXPENSE_AGENT_SMOKE_API_BASE_URL ?? "https://api.expense-budget-tracker.com/v1",
);
const appBaseUrl = trimTrailingSlash(
  process.env.EXPENSE_AGENT_SMOKE_APP_BASE_URL ?? "https://app.expense-budget-tracker.com",
);
const reviewEmail = (process.env.EXPENSE_AGENT_SMOKE_REVIEW_EMAIL ?? "e2e-test@example.com").trim().toLowerCase();
const runId = (process.env.GITHUB_RUN_ID ?? `${Date.now()}`).trim();
const workspaceName = `E2E agent api ${runId}`;
const connectionLabel = `agent-api-smoke-${runId}`;
const retryDelayMs = 2_000;
const maxAttempts = 5;

async function main() {
  /** @type {string | null} */
  let createdWorkspaceId = null;
  /** @type {string | null} */
  let issuedApiKey = null;
  /** @type {string | null} */
  let cleanupFailure = null;

  try {
    await verifyDiscoveryEndpoints();
    await verifyDocsEndpoints();
    const otpSessionToken = await sendAgentCode();
    issuedApiKey = await verifyAgentCode(otpSessionToken);
    await verifyUnauthorizedMe();
    await verifyAuthenticatedEndpoints(issuedApiKey);
    createdWorkspaceId = await createWorkspace(issuedApiKey, workspaceName);
    await selectWorkspace(issuedApiKey, createdWorkspaceId);
    const relationName = await verifySchema(issuedApiKey);
    await verifySql(issuedApiKey, relationName);
    console.log(`[agent-smoke] success runId=${runId} workspaceId=${createdWorkspaceId}`);
  } finally {
    if (createdWorkspaceId !== null) {
      try {
        await deleteWorkspaceThroughWeb(createdWorkspaceId, workspaceName);
      } catch (error) {
        cleanupFailure = error instanceof Error ? error.message : String(error);
        console.error(`[agent-smoke] cleanup_failed workspaceId=${createdWorkspaceId} error=${cleanupFailure}`);
      }
    }

    if (cleanupFailure !== null) {
      throw new Error(`Agent API smoke cleanup failed: ${cleanupFailure}`);
    }
  }
}

function trimTrailingSlash(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function assertCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function buildApiKeyHeaders(apiKey) {
  return {
    authorization: `ApiKey ${apiKey}`,
    "content-type": "application/json",
  };
}

function buildRequestOptions(method, headers, body) {
  const options = { method, headers };
  if (body !== null) {
    options.body = JSON.stringify(body);
  }
  return options;
}

async function readResponseBody(response) {
  const text = await response.text();
  if (text === "") {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return { rawText: text };
  }
}

function shouldRetryStatus(status) {
  return status >= 500;
}

async function requestJson(method, url, headers, body, expectedStatus, label, retryEnabled) {
  let attempt = 1;
  /** @type {Error | null} */
  let lastError = null;

  while (attempt <= maxAttempts) {
    try {
      const response = await fetch(url, buildRequestOptions(method, headers, body));
      const payload = await readResponseBody(response);

      if (response.status === expectedStatus) {
        return payload;
      }

      const failureMessage = `[agent-smoke] ${label} failed method=${method} url=${url} status=${response.status} body=${JSON.stringify(payload)}`;
      if (!retryEnabled || !shouldRetryStatus(response.status) || attempt === maxAttempts) {
        throw new Error(failureMessage);
      }

      console.warn(`${failureMessage} retry=${attempt}/${maxAttempts}`);
      await sleep(retryDelayMs);
      attempt += 1;
      continue;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (!retryEnabled || attempt === maxAttempts) {
        throw lastError;
      }

      console.warn(`[agent-smoke] ${label} transport failure method=${method} url=${url} error=${lastError.message} retry=${attempt}/${maxAttempts}`);
      await sleep(retryDelayMs);
      attempt += 1;
    }
  }

  throw lastError ?? new Error(`[agent-smoke] ${label} failed without an error`);
}

function expectEnvelope(payload, label) {
  assertCondition(payload !== null && typeof payload === "object", `${label}: response is not an object`);
  assertCondition(typeof payload.ok === "boolean", `${label}: missing ok flag`);
  assertCondition(payload.data !== null && typeof payload.data === "object", `${label}: missing data object`);
  assertCondition(Array.isArray(payload.actions), `${label}: missing actions array`);
  assertCondition(typeof payload.instructions === "string", `${label}: missing instructions`);
}

function expectActionNamed(payload, actionName, label) {
  const action = payload.actions.find((candidate) => candidate !== null && typeof candidate === "object" && candidate.name === actionName);
  assertCondition(action !== undefined, `${label}: missing action ${actionName}`);
  return action;
}

function generateCsrfToken() {
  return randomBytes(32).toString("hex");
}

function buildWebAuthHeaders(idToken, workspaceId) {
  const csrf = generateCsrfToken();
  const cookies = [`session=${idToken}`, `__Host-csrf=${csrf}`];
  if (workspaceId !== null) {
    cookies.push(`workspace=${workspaceId}`);
  }

  return {
    cookie: cookies.join("; "),
    "x-csrf-token": csrf,
    origin: appBaseUrl,
    "content-type": "application/json",
  };
}

async function signInWithDemoEmail() {
  const payload = await requestJson(
    "POST",
    `${authBaseUrl}/api/send-code`,
    { "content-type": "application/json" },
    { email: reviewEmail },
    200,
    "web_demo_sign_in",
    true,
  );

  assertCondition(typeof payload.idToken === "string" && payload.idToken !== "", "web_demo_sign_in: missing idToken");
  return payload.idToken;
}

async function deleteWorkspaceThroughWeb(workspaceId, targetWorkspaceName) {
  const idToken = await signInWithDemoEmail();
  const payload = await requestJson(
    "POST",
    `${appBaseUrl}/api/workspaces/${workspaceId}/delete`,
    buildWebAuthHeaders(idToken, workspaceId),
    { confirmText: targetWorkspaceName },
    200,
    "delete_workspace",
    true,
  );

  assertCondition(payload.ok === true, "delete_workspace: expected ok=true");
  console.log(`[agent-smoke] cleanup_deleted workspaceId=${workspaceId}`);
}

async function verifyDiscoveryEndpoints() {
  const discovery = await requestJson("GET", `${apiBaseUrl}/`, {}, null, 200, "discovery_root", true);
  expectEnvelope(discovery, "discovery_root");
  assertCondition(discovery.data.auth.bootstrapUrl === `${authBaseUrl}/api/agent/send-code`, "discovery_root: bootstrapUrl mismatch");
  assertCondition(discovery.data.authBaseUrl === authBaseUrl, "discovery_root: authBaseUrl mismatch");
  assertCondition(discovery.data.apiBaseUrl === apiBaseUrl, "discovery_root: apiBaseUrl mismatch");
  expectActionNamed(discovery, "send_code", "discovery_root");

  const agentDiscovery = await requestJson("GET", `${apiBaseUrl}/agent`, {}, null, 200, "discovery_agent", true);
  expectEnvelope(agentDiscovery, "discovery_agent");
  assertCondition(agentDiscovery.data.auth.bootstrapUrl === discovery.data.auth.bootstrapUrl, "discovery_agent: bootstrapUrl mismatch");
  assertCondition(agentDiscovery.data.authBaseUrl === discovery.data.authBaseUrl, "discovery_agent: authBaseUrl mismatch");
  assertCondition(agentDiscovery.data.apiBaseUrl === discovery.data.apiBaseUrl, "discovery_agent: apiBaseUrl mismatch");
}

async function verifyDocsEndpoints() {
  const openapi = await requestJson("GET", `${apiBaseUrl}/openapi.json`, {}, null, 200, "openapi_json", true);
  const swagger = await requestJson("GET", `${apiBaseUrl}/swagger.json`, {}, null, 200, "swagger_json", true);

  assertCondition(openapi !== null && typeof openapi === "object", "openapi_json: payload is not an object");
  assertCondition(swagger !== null && typeof swagger === "object", "swagger_json: payload is not an object");
  assertCondition(openapi.openapi === "3.1.0", "openapi_json: unexpected version");
  assertCondition(swagger.openapi === "3.1.0", "swagger_json: unexpected version");

  const requiredPaths = [
    "/",
    "/agent",
    "/openapi.json",
    "/swagger.json",
    "/me",
    "/workspaces",
    "/workspaces/{workspaceId}/select",
    "/schema",
    "/sql",
    "/api/agent/send-code",
    "/api/agent/verify-code",
  ];

  for (const path of requiredPaths) {
    assertCondition(openapi.paths?.[path] !== undefined, `openapi_json: missing path ${path}`);
    assertCondition(swagger.paths?.[path] !== undefined, `swagger_json: missing path ${path}`);
  }
}

async function sendAgentCode() {
  const payload = await requestJson(
    "POST",
    `${authBaseUrl}/api/agent/send-code`,
    { "content-type": "application/json" },
    { email: reviewEmail },
    200,
    "agent_send_code",
    true,
  );

  expectEnvelope(payload, "agent_send_code");
  assertCondition(typeof payload.data.otpSessionToken === "string" && payload.data.otpSessionToken !== "", "agent_send_code: missing otpSessionToken");
  expectActionNamed(payload, "verify_code", "agent_send_code");
  return payload.data.otpSessionToken;
}

async function verifyAgentCode(otpSessionToken) {
  const payload = await requestJson(
    "POST",
    `${authBaseUrl}/api/agent/verify-code`,
    { "content-type": "application/json" },
    { otpSessionToken, label: connectionLabel },
    200,
    "agent_verify_code",
    true,
  );

  expectEnvelope(payload, "agent_verify_code");
  assertCondition(typeof payload.data.apiKey === "string" && payload.data.apiKey !== "", "agent_verify_code: missing apiKey");
  assertCondition(payload.data.connection?.label === connectionLabel, "agent_verify_code: connection label mismatch");
  expectActionNamed(payload, "load_account", "agent_verify_code");
  expectActionNamed(payload, "list_workspaces", "agent_verify_code");
  expectActionNamed(payload, "select_workspace", "agent_verify_code");
  expectActionNamed(payload, "schema", "agent_verify_code");
  return payload.data.apiKey;
}

async function verifyUnauthorizedMe() {
  const payload = await requestJson("GET", `${apiBaseUrl}/me`, {}, null, 401, "me_unauthorized", false);
  expectEnvelope(payload, "me_unauthorized");
  assertCondition(payload.error?.code === "missing_api_key", "me_unauthorized: expected missing_api_key");
}

async function verifyAuthenticatedEndpoints(apiKey) {
  const headers = { authorization: `ApiKey ${apiKey}` };

  const mePayload = await requestJson("GET", `${apiBaseUrl}/me`, headers, null, 200, "me_authorized", true);
  expectEnvelope(mePayload, "me_authorized");
  assertCondition(typeof mePayload.data.user?.userId === "string" && mePayload.data.user.userId !== "", "me_authorized: missing userId");
  assertCondition(mePayload.data.user?.email === reviewEmail, "me_authorized: email mismatch");
  assertCondition(typeof mePayload.data.connection?.connectionId === "string" && mePayload.data.connection.connectionId !== "", "me_authorized: missing connectionId");
  assertCondition(mePayload.data.connection?.label === connectionLabel, "me_authorized: connection label mismatch");
  assertCondition(!("defaultWorkspaceId" in mePayload.data), "me_authorized: defaultWorkspaceId should be omitted");

  const workspacesPayload = await requestJson("GET", `${apiBaseUrl}/workspaces`, headers, null, 200, "workspaces_list", true);
  expectEnvelope(workspacesPayload, "workspaces_list");
  assertCondition(Array.isArray(workspacesPayload.data.workspaces), "workspaces_list: workspaces is not an array");
  assertCondition(workspacesPayload.data.workspaces.length >= 1, "workspaces_list: expected at least one workspace");
}

async function createWorkspace(apiKey, targetWorkspaceName) {
  const payload = await requestJson(
    "POST",
    `${apiBaseUrl}/workspaces`,
    buildApiKeyHeaders(apiKey),
    { name: targetWorkspaceName },
    200,
    "workspace_create",
    true,
  );

  expectEnvelope(payload, "workspace_create");
  assertCondition(payload.data.workspace?.name === targetWorkspaceName, "workspace_create: workspace name mismatch");
  assertCondition(typeof payload.data.workspace?.workspaceId === "string" && payload.data.workspace.workspaceId !== "", "workspace_create: missing workspaceId");
  return payload.data.workspace.workspaceId;
}

async function selectWorkspace(apiKey, workspaceId) {
  const payload = await requestJson(
    "POST",
    `${apiBaseUrl}/workspaces/${workspaceId}/select`,
    buildApiKeyHeaders(apiKey),
    {},
    200,
    "workspace_select",
    true,
  );

  expectEnvelope(payload, "workspace_select");
  assertCondition(payload.data.workspace?.workspaceId === workspaceId, "workspace_select: workspaceId mismatch");
  assertCondition(payload.data.sqlRequest?.header === "X-Workspace-Id", "workspace_select: missing sqlRequest header");
  expectActionNamed(payload, "run_sql", "workspace_select");
}

async function verifySchema(apiKey) {
  const payload = await requestJson(
    "GET",
    `${apiBaseUrl}/schema`,
    { authorization: `ApiKey ${apiKey}` },
    null,
    200,
    "schema",
    true,
  );

  expectEnvelope(payload, "schema");
  assertCondition(Array.isArray(payload.data.relations), "schema: relations is not an array");
  assertCondition(payload.data.relations.length >= 1, "schema: expected at least one relation");

  const relation = payload.data.relations[0];
  assertCondition(typeof relation?.name === "string" && relation.name !== "", "schema: missing relation name");
  assertCondition(Array.isArray(relation?.columns) && relation.columns.length >= 1, "schema: missing columns");
  return relation.name;
}

async function verifySql(apiKey, relationName) {
  assertCondition(/^[a-z_]+$/.test(relationName), `sql: unexpected relation name ${relationName}`);
  const payload = await requestJson(
    "POST",
    `${apiBaseUrl}/sql`,
    buildApiKeyHeaders(apiKey),
    { sql: `SELECT * FROM ${relationName} LIMIT 0;` },
    200,
    "sql",
    true,
  );

  expectEnvelope(payload, "sql");
  assertCondition(Array.isArray(payload.data.statements), "sql: statements is not an array");
  assertCondition(payload.data.statements.length >= 1, "sql: expected at least one statement");
  assertCondition(payload.data.statements[0]?.referencedRelations?.includes(relationName), "sql: referencedRelations mismatch");
}

await main();
