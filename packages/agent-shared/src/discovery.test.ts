import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentDiscoveryEnvelope } from "./discovery.js";

test("buildAgentDiscoveryEnvelope returns the canonical discovery payload", () => {
  const envelope = buildAgentDiscoveryEnvelope({
    apiBaseUrl: "https://api.example.com/v1",
    authBaseUrl: "https://auth.example.com",
    bootstrapUrl: "https://auth.example.com/api/agent/send-code",
  });

  assert.equal(envelope.ok, true);
  assert.equal(envelope.data["authBaseUrl"], "https://auth.example.com");
  assert.deepEqual(envelope.data["capabilities"], [
    "Load account context",
    "Select a workspace",
    "Inspect allowed SQL schema and hints",
    "Run restricted SQL scripts",
  ]);
  assert.match(String(envelope.instructions), /allowed relations, columns, and any agent hints/i);
  assert.match(String(envelope.instructions), /Restricted SQL does not support ON CONFLICT/i);
  assert.match(String(envelope.instructions), /tiny representative probe/i);
  assert.match(String(envelope.instructions), /at most 100 records per tool call/i);
  assert.match(String(envelope.instructions), /approval covers the full approved dataset/i);
});
