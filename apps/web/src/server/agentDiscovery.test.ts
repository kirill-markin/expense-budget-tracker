import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentDiscoveryEnvelope } from "./agentDiscovery";

test("buildAgentDiscoveryEnvelope points agents to ask for email before send_code", () => {
  process.env.AUTH_DOMAIN = "auth.example.com";
  process.env.CORS_ORIGIN = "https://app.example.com";

  const envelope = buildAgentDiscoveryEnvelope(new Request("https://app.example.com/api/agent"));

  assert.equal(envelope.ok, true);
  assert.deepEqual(envelope.actions, [{
    name: "send_code",
    method: "POST",
    url: "https://auth.example.com/api/agent/send-code",
    input: { email: "string" },
    auth: "none",
  }]);
  const flow = envelope.data["flow"];
  assert.ok(Array.isArray(flow));
  assert.equal(flow[0], "1. Ask which email the user wants to use, then POST it to send_code on auth.*");
  assert.match(envelope.instructions, /Ask the user which email address they want to use/);
  assert.match(envelope.instructions, /start using the service for free/);
});

test("buildAgentDiscoveryEnvelope falls back to the request origin when auth env is missing", () => {
  delete process.env.AUTH_DOMAIN;
  delete process.env.CORS_ORIGIN;

  const envelope = buildAgentDiscoveryEnvelope(new Request("https://app.example.com/api/agent"));

  assert.deepEqual(envelope.actions, [{
    name: "send_code",
    method: "POST",
    url: "https://app.example.com/api/agent/send-code",
    input: { email: "string" },
    auth: "none",
  }]);
});
