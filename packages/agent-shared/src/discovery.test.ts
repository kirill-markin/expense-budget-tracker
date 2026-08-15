import assert from "node:assert/strict";
import test from "node:test";
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

test("agent discovery advertises runtime documentation and implementation source", (): void => {
  const envelope = buildAgentDiscoveryEnvelope({
    apiBaseUrl: API_BASE_URL,
    authBaseUrl: "https://auth.expense-budget-tracker.com",
    bootstrapUrl: "https://auth.expense-budget-tracker.com/api/agent/send-code",
    mcpUrl: "https://mcp.expense-budget-tracker.com/mcp",
  });

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
  assert.equal(envelope.actions.some((action) => action.name === "openapi"), false);
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
