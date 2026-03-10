import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentDiscoveryEnvelope } from "./agentDiscovery";

test("buildAgentDiscoveryEnvelope points agents to ask for email before send_code", () => {
  process.env.AUTH_DOMAIN = "auth.example.com";
  process.env.CORS_ORIGIN = "https://app.example.com";

  const envelope = buildAgentDiscoveryEnvelope(new Request("https://app.example.com/api/agent"));

  assert.equal(envelope.ok, true);
  assert.deepEqual(envelope.actions, [
    {
      name: "send_code",
      method: "POST",
      url: "https://auth.example.com/api/agent/send-code",
      input: { email: "string" },
      auth: "none",
    },
    {
      name: "openapi",
      method: "GET",
      url: "https://api.example.com/v1/openapi.json",
      auth: "none",
    },
  ]);
  assert.deepEqual(envelope.data["docs"], {
    openapiUrl: "https://api.example.com/v1/openapi.json",
    swaggerUrl: "https://api.example.com/v1/swagger.json",
  });
  assert.match(String(envelope.instructions), /Ask the user for their email address first/i);
  assert.match(String(envelope.instructions), /same email OTP flow handles both signup and login/i);
  assert.match(String(envelope.instructions), /\.env file as EXPENSE_BUDGET_TRACKER_API_KEY='<PASTE_KEY_HERE>'/i);
  assert.match(String(envelope.instructions), /Authorization: ApiKey \$EXPENSE_BUDGET_TRACKER_API_KEY/);
  assert.match(String(envelope.instructions), /https:\/\/api\.example\.com\/v1\/me/);
});

test("buildAgentDiscoveryEnvelope falls back to the request origin when auth env is missing", () => {
  delete process.env.AUTH_DOMAIN;
  delete process.env.CORS_ORIGIN;

  const envelope = buildAgentDiscoveryEnvelope(new Request("https://app.example.com/api/agent"));

  assert.deepEqual(envelope.actions, [
    {
      name: "send_code",
      method: "POST",
      url: "https://app.example.com/api/agent/send-code",
      input: { email: "string" },
      auth: "none",
    },
    {
      name: "openapi",
      method: "GET",
      url: "https://api.example.com/v1/openapi.json",
      auth: "none",
    },
  ]);
});
