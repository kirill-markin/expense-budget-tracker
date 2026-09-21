import assert from "node:assert/strict";
import test from "node:test";
import {
  SQL_DIALECT_GUIDE,
  WRITE_APPROVAL_GUIDE,
  WRITE_PROTOCOL_INTRO_GUIDE,
} from "./agentProtocol.js";
import {
  buildAgentDiscoveryEnvelope,
  buildSourceDiscoveryResponse,
} from "./discovery.js";

const API_BASE_URL = "https://api.expense-budget-tracker.com/v1";
const DOCS_URL = "https://github.com/kirill-markin/expense-budget-tracker/blob/main/README.md";
const SOURCE_LINKS = {
  repositoryUrl: "https://github.com/kirill-markin/expense-budget-tracker",
  sqlApiUrl: "https://github.com/kirill-markin/expense-budget-tracker/tree/main/apps/sql-api/src",
  authRoutesUrl: "https://github.com/kirill-markin/expense-budget-tracker/tree/main/apps/auth/src/routes",
};

const buildEmailOtpEnvelope = (): ReturnType<typeof buildAgentDiscoveryEnvelope> =>
  buildAgentDiscoveryEnvelope({
    apiBaseUrl: API_BASE_URL,
    authBaseUrl: "https://auth.expense-budget-tracker.com",
    onboarding: {
      kind: "email_otp",
      bootstrapUrl: "https://auth.expense-budget-tracker.com/api/agent/send-code",
    },
    mcpUrl: "https://mcp.expense-budget-tracker.com/mcp",
  });

test("agent discovery advertises runtime documentation and implementation source", (): void => {
  const envelope = buildEmailOtpEnvelope();

  assert.deepEqual(envelope.data["docs"], {
    discoveryUrl: `${API_BASE_URL}/`,
    docsUrl: DOCS_URL,
    source: SOURCE_LINKS,
  });
  assert.deepEqual(envelope.data["auth"], {
    bootstrapUrl: "https://auth.expense-budget-tracker.com/api/agent/send-code",
    scheme: "Authorization: ApiKey <key>",
    oauth: {
      issuer: "https://auth.expense-budget-tracker.com",
      scopes: ["expenses:read", "expenses:write"],
    },
  });
  assert.deepEqual(envelope.data["mcp"], {
    url: "https://mcp.expense-budget-tracker.com/mcp",
    transport: "streamable-http",
  });
  assert.deepEqual(envelope.actions.map((action) => action.name), [
    "send_code",
    "schema",
    "run_sql_query",
    "run_sql_execute",
  ]);
  assert.deepEqual(
    envelope.actions.slice(2).map((action) => action.url),
    [`${API_BASE_URL}/sql/query`, `${API_BASE_URL}/sql/execute`],
  );
  assert.equal(
    envelope.actions.find((action) => action.name === "run_sql_execute")?.description,
    "Run exactly one explicitly approved INSERT, UPDATE, or DELETE mutation.",
  );
  assert.match(envelope.instructions, /Legacy .*\/sql remains available only for compatibility/u);
  assert.ok(
    envelope.instructions.includes(SQL_DIALECT_GUIDE),
    "Discovery must inline the shared restricted SQL dialect guide instead of restating it",
  );
  assert.ok(
    envelope.instructions.includes(WRITE_PROTOCOL_INTRO_GUIDE),
    "Discovery must inline the shared write protocol intro instead of restating it",
  );
  assert.ok(
    envelope.instructions.includes(WRITE_APPROVAL_GUIDE),
    "Discovery must inline the shared write approval and execution section in full",
  );
  assert.match(
    envelope.instructions,
    /The Writing data sections above are an excerpt of the shared write guide/u,
  );
  assert.match(envelope.instructions, /is not available over this API\./u);
  assert.equal(envelope.actions.some((action) => action.name === "openapi"), false);
});

// The auth service registers the email OTP routes only in AUTH_MODE=cognito,
// so a browser-onboarding deployment must advertise neither the bootstrap URL
// nor the send_code action: both answer 404 there.
test("browser onboarding replaces the email OTP bootstrap with the in-app key creation", (): void => {
  const envelope = buildAgentDiscoveryEnvelope({
    apiBaseUrl: API_BASE_URL,
    authBaseUrl: "https://auth.example.com",
    onboarding: { kind: "browser_api_key", appBaseUrl: "https://app.example.com" },
    mcpUrl: "https://mcp.example.com/mcp",
  });

  assert.deepEqual(envelope.data["auth"], {
    scheme: "Authorization: ApiKey <key>",
    oauth: {
      issuer: "https://auth.example.com",
      scopes: ["expenses:read", "expenses:write"],
    },
  });
  assert.equal(envelope.actions.some((action) => action.name === "send_code"), false);
  assert.deepEqual(envelope.actions.map((action) => action.name), [
    "schema",
    "run_sql_query",
    "run_sql_execute",
  ]);
  assert.equal(envelope.instructions.includes("send_code"), false);
  assert.equal(envelope.instructions.includes("/api/agent/send-code"), false);
  // The app runs on its own hostname, so the envelope has to name it: without
  // it an agent holding only this response cannot tell the user where to go.
  assert.equal(envelope.data["appBaseUrl"], "https://app.example.com");
  assert.match(
    envelope.instructions,
    /in the browser app at https:\/\/app\.example\.com, under Settings -> Agent and Program Access -> Create an API key/u,
  );
  assert.match(
    envelope.instructions,
    /no key is issued to a terminal or an API call without a signed-in browser session/u,
  );
  // Everything downstream of obtaining a key is shared with the email OTP shape.
  assert.ok(
    envelope.instructions.includes(`${API_BASE_URL}/workspaces/{workspaceId}/select before SQL`),
    "Browser onboarding must keep the shared endpoint walkthrough",
  );
  assert.ok(envelope.instructions.includes(SQL_DIALECT_GUIDE));
  assert.ok(envelope.instructions.includes(WRITE_APPROVAL_GUIDE));
});

// The hosted cognito deployment serves this shape, and it must stay byte for
// byte what it was before onboarding became mode-dependent: same keys, same
// order, no appBaseUrl, send_code first.
test("the email OTP shape keeps the send_code action first and its bootstrap URL", (): void => {
  const envelope = buildEmailOtpEnvelope();

  assert.deepEqual(Object.keys(envelope.data), [
    "service",
    "auth",
    "apiBaseUrl",
    "authBaseUrl",
    "mcp",
    "docs",
    "capabilities",
  ]);
  assert.deepEqual(Object.keys(envelope.data["auth"] as object), [
    "bootstrapUrl",
    "scheme",
    "oauth",
  ]);
  assert.equal(
    (envelope.data["auth"] as Readonly<{ bootstrapUrl: string }>).bootstrapUrl,
    "https://auth.expense-budget-tracker.com/api/agent/send-code",
  );
  assert.equal(envelope.actions[0]?.name, "send_code");
  assert.equal(
    envelope.actions[0]?.url,
    "https://auth.expense-budget-tracker.com/api/agent/send-code",
  );
  assert.match(envelope.instructions, /then call send_code/u);
});

test("source discovery explains the conventional OpenAPI compatibility response", (): void => {
  const response = buildSourceDiscoveryResponse(API_BASE_URL);

  assert.deepEqual(Object.keys(response), [
    "ok",
    "openapiAvailable",
    "message",
    "discoveryUrl",
    "docsUrl",
    "source",
  ]);
  assert.equal(response.ok, true);
  assert.equal(response.openapiAvailable, false);
  assert.match(response.message, /^[\x20-\x7e]{1,100}$/u);
  assert.equal(response.discoveryUrl, `${API_BASE_URL}/`);
  assert.equal(response.docsUrl, DOCS_URL);
  assert.deepEqual(response.source, SOURCE_LINKS);
  assert.equal("openapi" in response, false);
});
