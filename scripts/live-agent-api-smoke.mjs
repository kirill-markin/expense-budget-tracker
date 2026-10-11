/**
 * Post-deploy smoke for the public agent API contract.
 *
 * Validates runtime discovery and every supported endpoint using the shared
 * review email path, then revokes the minted API key and deletes the
 * disposable workspace via the web app.
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
// Same prefix the scheduled deleter defaults to (scripts/cleanup-live-e2e-workspaces.mjs),
// so the workspace this run creates and the ones it skips stay in step with it.
const disposableWorkspacePrefix = "E2E ";
// That deleter ages a workspace by the last space-separated part of its name,
// read as a millisecond epoch, so the name ends with one and keeps the run id
// ahead of it for traceability.
const workspaceName = `${disposableWorkspacePrefix}agent api run${runId} ${Date.now()}`;
const connectionLabel = `agent-api-smoke-${runId}`;
const retryDelayMs = 2_000;
const maxAttempts = 5;
const sourceRepositoryUrl = "https://github.com/kirill-markin/expense-budget-tracker";
const sourceDocsUrl = `${sourceRepositoryUrl}/blob/main/README.md`;

async function main() {
  /** @type {string | null} */
  let createdWorkspaceId = null;
  /** @type {string | null} */
  let issuedApiKey = null;
  /** @type {string | null} */
  let mintedConnectionId = null;
  /** @type {Error | null} */
  let smokeFailure = null;

  try {
    await verifyDiscoveryEndpoints();
    await verifySourceDiscoveryEndpoints();
    const otpSessionToken = await sendAgentCode();
    // The key is live in auth.agent_api_keys as soon as the mint response
    // exists, so capture it before any other check: every assertion below runs
    // with cleanup already armed.
    const minted = await mintAgentApiKey(otpSessionToken);
    issuedApiKey = minted.apiKey;
    mintedConnectionId = minted.connectionId;
    verifyAgentCodeContract(minted.payload);
    await verifyUnauthorizedMe();
    await verifyAuthenticatedEndpoints(issuedApiKey, mintedConnectionId);
    createdWorkspaceId = await createWorkspace(issuedApiKey, workspaceName);
    await selectWorkspace(issuedApiKey, createdWorkspaceId);
    const relationName = await verifySchema(issuedApiKey);
    await verifySql(issuedApiKey, relationName);
    await verifySqlWriteThenRead(issuedApiKey, createdWorkspaceId);
    console.log(`[agent-smoke] success runId=${runId} workspaceId=${createdWorkspaceId}`);
  } catch (error) {
    smokeFailure = error instanceof Error ? error : new Error(describeError(error));
  }

  const cleanupFailures = await runCleanup(mintedConnectionId, issuedApiKey, createdWorkspaceId);

  if (cleanupFailures.length > 0) {
    if (smokeFailure !== null) {
      console.error(`[agent-smoke] smoke_failed error=${smokeFailure.message}`);
    }
    throw new Error(
      `Agent API smoke cleanup failed: ${cleanupFailures.join("; ")}`,
      smokeFailure === null ? undefined : { cause: smokeFailure },
    );
  }

  if (smokeFailure !== null) {
    throw smokeFailure;
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

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
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

function buildStatusFailureMessage(label, method, url, status, payload) {
  return `[agent-smoke] ${label} failed method=${method} url=${url} status=${status} body=${JSON.stringify(payload)}`;
}

async function requestJson(method, url, headers, body, expectedStatus, label, retryEnabled) {
  let attempt = 1;
  /** @type {Error | null} */
  let lastError = null;

  while (attempt <= maxAttempts) {
    /** @type {Response} */
    let response;
    /** @type {Record<string, unknown>} */
    let payload;
    // Only the transport is guarded: a status this run must not retry is
    // decided below, outside the catch, so it ends the run on its first error.
    try {
      response = await fetch(url, buildRequestOptions(method, headers, body));
      payload = await readResponseBody(response);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (!retryEnabled || attempt === maxAttempts) {
        throw lastError;
      }

      console.warn(`[agent-smoke] ${label} transport failure method=${method} url=${url} error=${lastError.message} retry=${attempt}/${maxAttempts}`);
      await sleep(retryDelayMs);
      attempt += 1;
      continue;
    }

    if (response.status === expectedStatus) {
      return payload;
    }

    const failureMessage = buildStatusFailureMessage(label, method, url, response.status, payload);
    if (!retryEnabled || !shouldRetryStatus(response.status) || attempt === maxAttempts) {
      throw new Error(failureMessage);
    }

    console.warn(`${failureMessage} retry=${attempt}/${maxAttempts}`);
    await sleep(retryDelayMs);
    attempt += 1;
  }

  throw lastError ?? new Error(`[agent-smoke] ${label} failed without an error`);
}

/**
 * One unretried request that reports an unknown server-side effect to the
 * caller instead of throwing: a 5xx, or a transport failure that may have been
 * raised after the request reached the server. Every other unexpected status
 * fails on the first response, as requestJson does.
 *
 * @returns {Promise<{ payload: Record<string, unknown> | null, unresolvedOutcome: string }>} exactly one of the two is set
 */
async function requestJsonKeepingUnresolvedOutcome(method, url, headers, body, expectedStatus, label) {
  /** @type {Response} */
  let response;
  /** @type {Record<string, unknown>} */
  let payload;
  try {
    response = await fetch(url, buildRequestOptions(method, headers, body));
    payload = await readResponseBody(response);
  } catch (error) {
    return { payload: null, unresolvedOutcome: `${label} transport failure method=${method} url=${url} error=${describeError(error)}` };
  }

  if (response.status === expectedStatus) {
    return { payload, unresolvedOutcome: "" };
  }

  if (response.status < 500) {
    throw new Error(buildStatusFailureMessage(label, method, url, response.status, payload));
  }

  return { payload: null, unresolvedOutcome: `${label} status=${response.status} body=${JSON.stringify(payload)}` };
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

function expectSourceLinks(source, label) {
  assertCondition(source !== null && typeof source === "object", `${label}: missing source links`);
  assertCondition(source.repositoryUrl === sourceRepositoryUrl, `${label}: repositoryUrl mismatch`);
  assertCondition(source.sqlApiUrl === `${sourceRepositoryUrl}/tree/main/apps/sql-api/src`, `${label}: sqlApiUrl mismatch`);
  assertCondition(source.authRoutesUrl === `${sourceRepositoryUrl}/tree/main/apps/auth/src/routes`, `${label}: authRoutesUrl mismatch`);
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

async function attemptCleanupStep(label, action) {
  try {
    await action();
    return null;
  } catch (error) {
    const message = describeError(error);
    console.error(`[agent-smoke] cleanup_failed step=${label} error=${message}`);
    return `${label}: ${message}`;
  }
}

/** Ids an operator needs to finish by hand, listing only what is still live. */
function withLeftovers(failure, connectionId, workspaceId) {
  return `${failure} (left behind: connectionId=${connectionId ?? "none"} workspaceId=${workspaceId ?? "none"})`;
}

/**
 * Revoke the API key this run minted and delete the workspace it created.
 *
 * Never throws: every failure is returned so the caller can report it next to
 * the smoke failure that may have triggered the cleanup. One web sign-in
 * serves both calls, each action runs even when the other fails, and the run
 * fails on any failure instead of leaving a live key or a workspace behind.
 */
async function runCleanup(mintedConnectionId, issuedApiKey, createdWorkspaceId) {
  if (mintedConnectionId === null && createdWorkspaceId === null) {
    return [];
  }

  /** @type {string} */
  let idToken;
  try {
    idToken = await signInWithDemoEmail();
  } catch (error) {
    const message = describeError(error);
    console.error(`[agent-smoke] cleanup_failed step=web_sign_in error=${message}`);
    return [withLeftovers(`web_sign_in: ${message}`, mintedConnectionId, createdWorkspaceId)];
  }

  /** @type {Array<string>} */
  const failures = [];
  /** @type {string | null} */
  let liveConnectionId = mintedConnectionId;
  /** @type {string | null} */
  let liveWorkspaceId = createdWorkspaceId;

  if (mintedConnectionId !== null) {
    const failure = await attemptCleanupStep("revoke_connection", async () => {
      assertCondition(issuedApiKey !== null, "revoke_connection: connection id captured without its API key");
      await revokeMintedConnection(idToken, issuedApiKey, mintedConnectionId, createdWorkspaceId);
    });
    if (failure !== null) {
      failures.push(failure);
    } else {
      liveConnectionId = null;
    }
  }

  if (createdWorkspaceId !== null) {
    const failure = await attemptCleanupStep(
      "delete_workspace",
      async () => deleteWorkspaceThroughWeb(idToken, createdWorkspaceId, workspaceName),
    );
    if (failure !== null) {
      failures.push(failure);
    } else {
      liveWorkspaceId = null;
    }
  }

  return failures.map((failure) => withLeftovers(failure, liveConnectionId, liveWorkspaceId));
}

/**
 * Revoke the minted connection before the workspace delete below removes the
 * scope it runs in: the web route resolves a workspace from the request, and
 * ensureProvisionedIdentity rejects a workspace the account no longer belongs
 * to (apps/web/src/server/db/provisioning.ts).
 *
 * The workspace this run created is the first scope because the run owns it.
 * It is not guaranteed to survive, so a failed attempt retries once against a
 * workspace of the review account that no cleanup removes; both errors are
 * reported if that retry fails too.
 */
async function revokeMintedConnection(idToken, apiKey, connectionId, createdWorkspaceId) {
  if (createdWorkspaceId === null) {
    const workspaceId = await resolveRevokeWorkspaceId(apiKey, connectionId);
    await revokeConnectionThroughWeb(idToken, workspaceId, connectionId);
    return;
  }

  try {
    await revokeConnectionThroughWeb(idToken, createdWorkspaceId, connectionId);
    return;
  } catch (error) {
    const firstMessage = describeError(error);
    console.warn(`[agent-smoke] revoke_scope_retry workspaceId=${createdWorkspaceId} error=${firstMessage}`);
    try {
      const workspaceId = await resolveRevokeWorkspaceId(apiKey, connectionId);
      await revokeConnectionThroughWeb(idToken, workspaceId, connectionId);
    } catch (retryError) {
      throw new Error(
        `${describeError(retryError)} (first scope workspaceId=${createdWorkspaceId}: ${firstMessage})`,
        { cause: error },
      );
    }
  }
}

/**
 * Pick a workspace of the review account to scope the revoke call. Disposable
 * workspaces are skipped: sibling smoke jobs and the scheduled cleanup create
 * and delete them concurrently with this run.
 */
async function resolveRevokeWorkspaceId(apiKey, connectionId) {
  const payload = await requestJson(
    "GET",
    `${apiBaseUrl}/workspaces`,
    { authorization: `ApiKey ${apiKey}` },
    null,
    200,
    "revoke_scope_lookup",
    true,
  );

  const workspaces = Array.isArray(payload.data?.workspaces) ? payload.data.workspaces : [];
  const stable = workspaces.find((candidate) => (
    typeof candidate?.workspaceId === "string"
    && candidate.workspaceId !== ""
    && typeof candidate?.name === "string"
    && !candidate.name.startsWith(disposableWorkspacePrefix)
  ));

  assertCondition(
    stable !== undefined,
    `revoke_scope_lookup: no workspace outside the disposable "${disposableWorkspacePrefix}" prefix among ${workspaces.length} workspaces of ${reviewEmail}; revoke connectionId=${connectionId} by hand`,
  );
  return stable.workspaceId;
}

async function revokeConnectionThroughWeb(idToken, workspaceId, connectionId) {
  const payload = await requestJson(
    "POST",
    `${appBaseUrl}/api/agent-connections/${connectionId}/revoke`,
    buildWebAuthHeaders(idToken, workspaceId),
    null,
    200,
    "revoke_connection",
    true,
  );

  assertCondition(
    payload.revoked === true,
    `revoke_connection: expected revoked=true, got ${JSON.stringify(payload)}`,
  );
  console.log(`[agent-smoke] cleanup_revoked connectionId=${connectionId}`);
}

async function deleteWorkspaceThroughWeb(idToken, workspaceId, targetWorkspaceName) {
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
  assertCondition(discovery.data.docs?.discoveryUrl === `${apiBaseUrl}/`, "discovery_root: discoveryUrl mismatch");
  assertCondition(discovery.data.docs?.docsUrl === sourceDocsUrl, "discovery_root: docsUrl mismatch");
  expectSourceLinks(discovery.data.docs?.source, "discovery_root");
  expectActionNamed(discovery, "send_code", "discovery_root");
  expectActionNamed(discovery, "schema", "discovery_root");
  assertCondition(
    discovery.actions.every((action) => action?.name !== "openapi"),
    "discovery_root: OpenAPI action must not be advertised",
  );

  const agentDiscovery = await requestJson("GET", `${apiBaseUrl}/agent`, {}, null, 200, "discovery_agent", true);
  expectEnvelope(agentDiscovery, "discovery_agent");
  assertCondition(agentDiscovery.data.auth.bootstrapUrl === discovery.data.auth.bootstrapUrl, "discovery_agent: bootstrapUrl mismatch");
  assertCondition(agentDiscovery.data.authBaseUrl === discovery.data.authBaseUrl, "discovery_agent: authBaseUrl mismatch");
  assertCondition(agentDiscovery.data.apiBaseUrl === discovery.data.apiBaseUrl, "discovery_agent: apiBaseUrl mismatch");
  assertCondition(JSON.stringify(agentDiscovery.data.docs) === JSON.stringify(discovery.data.docs), "discovery_agent: docs mismatch");
}

async function verifySourceDiscoveryEndpoints() {
  const openapi = await requestJson("GET", `${apiBaseUrl}/openapi.json`, {}, null, 200, "openapi_json", true);
  const swagger = await requestJson("GET", `${apiBaseUrl}/swagger.json`, {}, null, 200, "swagger_json", true);

  for (const [label, payload] of [["openapi_json", openapi], ["swagger_json", swagger]]) {
    assertCondition(payload !== null && typeof payload === "object", `${label}: payload is not an object`);
    assertCondition(JSON.stringify(Object.keys(payload)) === JSON.stringify([
      "ok",
      "openapiAvailable",
      "message",
      "discoveryUrl",
      "docsUrl",
      "source",
    ]), `${label}: unexpected response keys`);
    assertCondition(payload.ok === true, `${label}: expected ok=true`);
    assertCondition(payload.openapiAvailable === false, `${label}: expected openapiAvailable=false`);
    assertCondition(typeof payload.message === "string" && /^[\x20-\x7e]{1,100}$/u.test(payload.message), `${label}: invalid message`);
    assertCondition(payload.discoveryUrl === `${apiBaseUrl}/`, `${label}: discoveryUrl mismatch`);
    assertCondition(payload.docsUrl === sourceDocsUrl, `${label}: docsUrl mismatch`);
    expectSourceLinks(payload.source, label);
    assertCondition(!("openapi" in payload), `${label}: unexpected OpenAPI document`);
  }

  assertCondition(JSON.stringify(swagger) === JSON.stringify(openapi), "swagger_json: response differs from openapi_json");
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

/**
 * Mint the API key and return it with its connection id and the raw response.
 * The contract checks stay with the caller, which is the only place that can
 * arm the cleanup revoking this key.
 */
async function mintAgentApiKey(otpSessionToken) {
  const payload = await requestJson(
    "POST",
    `${authBaseUrl}/api/agent/verify-code`,
    { "content-type": "application/json" },
    { otpSessionToken, label: connectionLabel },
    200,
    "agent_verify_code",
    true,
  );

  // The key row exists as soon as this response does, so name it before any
  // assertion: a failure below must still leave an operator a handle.
  console.log(`[agent-smoke] minted connectionId=${payload?.data?.connection?.connectionId ?? "none"} label=${connectionLabel}`);
  assertCondition(
    typeof payload?.data?.connection?.connectionId === "string" && payload.data.connection.connectionId !== "",
    "agent_verify_code: missing connectionId",
  );
  assertCondition(typeof payload.data.apiKey === "string" && payload.data.apiKey !== "", "agent_verify_code: missing apiKey");
  return { apiKey: payload.data.apiKey, connectionId: payload.data.connection.connectionId, payload };
}

function verifyAgentCodeContract(payload) {
  expectEnvelope(payload, "agent_verify_code");
  assertCondition(payload.data.connection?.label === connectionLabel, "agent_verify_code: connection label mismatch");
  expectActionNamed(payload, "load_account", "agent_verify_code");
  expectActionNamed(payload, "list_workspaces", "agent_verify_code");
  expectActionNamed(payload, "select_workspace", "agent_verify_code");
  expectActionNamed(payload, "schema", "agent_verify_code");
}

async function verifyUnauthorizedMe() {
  const payload = await requestJson("GET", `${apiBaseUrl}/me`, {}, null, 401, "me_unauthorized", false);
  expectEnvelope(payload, "me_unauthorized");
  assertCondition(payload.error?.code === "missing_api_key", "me_unauthorized: expected missing_api_key");
}

async function verifyAuthenticatedEndpoints(apiKey, mintedConnectionId) {
  const headers = { authorization: `ApiKey ${apiKey}` };

  const mePayload = await requestJson("GET", `${apiBaseUrl}/me`, headers, null, 200, "me_authorized", true);
  expectEnvelope(mePayload, "me_authorized");
  assertCondition(typeof mePayload.data.user?.userId === "string" && mePayload.data.user.userId !== "", "me_authorized: missing userId");
  assertCondition(mePayload.data.user?.email === reviewEmail, "me_authorized: email mismatch");
  assertCondition(
    mePayload.data.connection?.connectionId === mintedConnectionId,
    `me_authorized: connectionId ${JSON.stringify(mePayload.data.connection?.connectionId)} does not match the minted connection ${mintedConnectionId}`,
  );
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
  expectActionNamed(payload, "run_sql_query", "workspace_select");
  expectActionNamed(payload, "run_sql_execute", "workspace_select");
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

/**
 * Cover the two SQL endpoints /workspaces/{id}/select advertises as
 * run_sql_execute and run_sql_query: write one row, then read it back, so a
 * write that reports success without persisting fails the smoke.
 *
 * The marker account id is unique per run, so the read-back finds the row only
 * if this run's own write committed. account_metadata is the smallest
 * agent-writable relation (workspace_id, account_id, and defaulted columns) and
 * has no foreign key on account_id, so the row needs nothing else in the
 * workspace. It dies with the workspace the cleanup deletes.
 */
async function verifySqlWriteThenRead(apiKey, workspaceId) {
  // Both ids are interpolated into SQL literals, so they must stay free of
  // quotes; the server generates them, and a surprise ends the run here.
  assertCondition(/^[A-Za-z0-9_-]+$/.test(workspaceId), `sql_write: unexpected workspaceId ${workspaceId}`);
  const markerAccountId = `smoke-${runId}-${randomBytes(8).toString("hex")}`;
  assertCondition(/^[A-Za-z0-9_-]+$/.test(markerAccountId), `sql_write: unexpected marker ${markerAccountId}`);
  // The header the select step asserts, sent explicitly so both statements run
  // in the workspace this run owns rather than the key's saved one.
  const headers = { ...buildApiKeyHeaders(apiKey), "x-workspace-id": workspaceId };

  // Neither retried nor failed while the outcome is unknown: the insert is not
  // idempotent, so a blind retry would hit the primary key, and the API answers
  // an unknown mutation outcome by telling clients to verify instead of retry.
  // The read-back below is that verification, so it decides this step.
  const write = await requestJsonKeepingUnresolvedOutcome(
    "POST",
    `${apiBaseUrl}/sql/execute`,
    headers,
    { sql: `INSERT INTO account_metadata (workspace_id, account_id, liquidity) VALUES ('${workspaceId}', '${markerAccountId}', 'low')` },
    200,
    "sql_write",
  );

  // Empty unless the write left its outcome unknown; then it reaches whichever
  // read-back failure ends the run, since it is the first fact a reader needs.
  const unresolvedWrite = write.payload === null ? ` (unresolved ${write.unresolvedOutcome})` : "";
  if (write.payload === null) {
    console.error(`[agent-smoke] sql_write unresolved, verifying through sql/query instead of retrying: ${write.unresolvedOutcome}`);
  } else {
    expectEnvelope(write.payload, "sql_write");
    assertCondition(Array.isArray(write.payload.data.statements), "sql_write: statements is not an array");
    const writeStatement = write.payload.data.statements[0];
    assertCondition(writeStatement?.command === "INSERT", `sql_write: expected an INSERT command, got ${JSON.stringify(writeStatement?.command)}`);
    assertCondition(writeStatement?.rowCount === 1, `sql_write: expected one affected row, got ${JSON.stringify(writeStatement?.rowCount)}`);
    assertCondition(writeStatement?.referencedRelations?.includes("account_metadata"), "sql_write: referencedRelations mismatch");
  }

  try {
    const readPayload = await requestJson(
      "POST",
      `${apiBaseUrl}/sql/query`,
      headers,
      { sql: `SELECT account_id, liquidity FROM account_metadata WHERE workspace_id = '${workspaceId}' AND account_id = '${markerAccountId}'` },
      200,
      "sql_read_back",
      true,
    );

    expectEnvelope(readPayload, "sql_read_back");
    assertCondition(Array.isArray(readPayload.data.statements), "sql_read_back: statements is not an array");
    const readStatement = readPayload.data.statements[0];
    assertCondition(readStatement?.command === "SELECT", `sql_read_back: expected a SELECT command, got ${JSON.stringify(readStatement?.command)}`);
    assertCondition(Array.isArray(readStatement?.rows), "sql_read_back: rows is not an array");
    assertCondition(
      readStatement.rows.length === 1,
      `sql_read_back: expected exactly the written row, got ${readStatement.rows.length} rows for account_id=${markerAccountId} in workspaceId=${workspaceId}`,
    );
    assertCondition(readStatement.rows[0]?.account_id === markerAccountId, `sql_read_back: account_id mismatch in ${JSON.stringify(readStatement.rows[0])}`);
    assertCondition(readStatement.rows[0]?.liquidity === "low", `sql_read_back: liquidity mismatch in ${JSON.stringify(readStatement.rows[0])}`);
  } catch (error) {
    throw new Error(`${describeError(error)}${unresolvedWrite}`);
  }

  console.log(`[agent-smoke] sql_read_back accountId=${markerAccountId} workspaceId=${workspaceId}`);
}

await main();
