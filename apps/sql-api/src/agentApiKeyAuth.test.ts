import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { createQueryResult } from "./handlerTestUtils.js";
import {
  validateAgentApiKeyAuthorization,
  type AgentApiKeyAuthDependencies,
} from "./agentApiKeyAuth.js";

const KEY_ID = "ABCDEFGH";
const SECRET = "ABCDEFGHJKMNPQRSTVWXYZ0123";
const AUTHORIZATION = `ApiKey EBTA_${KEY_ID}_${SECRET}`;
const SECRET_HASH = crypto.createHash("sha256").update(SECRET).digest("hex");

type QueryCall = Readonly<{
  text: string;
  params: ReadonlyArray<unknown>;
}>;

type AgentApiKeyRowOverrides = Readonly<{
  email?: string | null;
  key_hash?: string;
  revoked_at?: string | null;
  last_used_at?: string | null;
}>;

const createRow = (overrides: AgentApiKeyRowOverrides): Readonly<Record<string, unknown>> => ({
  connection_id: "connection-1",
  user_id: "user-1",
  email: "user@example.com",
  key_hash: SECRET_HASH,
  revoked_at: null,
  last_used_at: null,
  label: "codex-desktop",
  created_at: "2026-03-10T00:00:00.000Z",
  ...overrides,
});

const createDependencies = (
  rows: ReadonlyArray<unknown>,
  calls: Array<QueryCall>,
): AgentApiKeyAuthDependencies => ({
  query: async (text, params) => {
    calls.push({ text, params });
    return createQueryResult(text.includes("validate_agent_api_key") ? rows : []);
  },
});

const expectRejection = async (authorization: string, rows: ReadonlyArray<unknown>): Promise<Array<QueryCall>> => {
  const calls: Array<QueryCall> = [];
  const context = await validateAgentApiKeyAuthorization(authorization, createDependencies(rows, calls));
  assert.equal(context, null);
  return calls;
};

test("returns the authorizer context for a valid ApiKey", async () => {
  const calls: Array<QueryCall> = [];
  const context = await validateAgentApiKeyAuthorization(
    AUTHORIZATION,
    createDependencies([createRow({ last_used_at: "2026-03-11T00:00:00.000Z" })], calls),
  );

  assert.deepEqual(context, {
    userId: "user-1",
    email: "user@example.com",
    connectionId: "connection-1",
    label: "codex-desktop",
    createdAt: "2026-03-10T00:00:00.000Z",
    lastUsedAt: "2026-03-11T00:00:00.000Z",
  });
  assert.deepEqual(calls, [
    { text: "SELECT * FROM auth.validate_agent_api_key($1)", params: [KEY_ID] },
    { text: "SELECT auth.touch_agent_api_key_usage($1)", params: ["connection-1"] },
  ]);
});

test("reports a never used key with an empty lastUsedAt", async () => {
  const calls: Array<QueryCall> = [];
  const context = await validateAgentApiKeyAuthorization(
    AUTHORIZATION,
    createDependencies([createRow({})], calls),
  );

  assert.equal(context?.lastUsedAt, "");
});

test("accepts separators and lowercase in the submitted key", async () => {
  const calls: Array<QueryCall> = [];
  const context = await validateAgentApiKeyAuthorization(
    `ApiKey ebta_${KEY_ID.toLowerCase()}_${SECRET.slice(0, 13).toLowerCase()}-${SECRET.slice(13).toLowerCase()}`,
    createDependencies([createRow({})], calls),
  );

  assert.equal(context?.userId, "user-1");
  assert.deepEqual(calls[0]?.params, [KEY_ID]);
});

test("rejects an authorization value without the ApiKey scheme", async () => {
  assert.deepEqual(await expectRejection("", [createRow({})]), []);
  assert.deepEqual(await expectRejection(`Bearer EBTA_${KEY_ID}_${SECRET}`, [createRow({})]), []);
  assert.deepEqual(await expectRejection(`apikey EBTA_${KEY_ID}_${SECRET}`, [createRow({})]), []);
});

test("rejects a wrong key prefix", async () => {
  assert.deepEqual(await expectRejection(`ApiKey EBTX_${KEY_ID}_${SECRET}`, [createRow({})]), []);
});

test("rejects a wrong segment count", async () => {
  assert.deepEqual(await expectRejection(`ApiKey EBTA_${KEY_ID}`, [createRow({})]), []);
  assert.deepEqual(await expectRejection(`ApiKey EBTA_${KEY_ID}_${SECRET}_EXTRA`, [createRow({})]), []);
});

test("rejects non-Crockford characters", async () => {
  assert.deepEqual(await expectRejection(`ApiKey EBTA_ABCDEFGU_${SECRET}`, [createRow({})]), []);
  assert.deepEqual(await expectRejection(`ApiKey EBTA_${KEY_ID}_${SECRET.slice(0, 25)}U`, [createRow({})]), []);
  assert.deepEqual(await expectRejection(`ApiKey EBTA__${SECRET}`, [createRow({})]), []);
});

test("rejects a wrong keyId length", async () => {
  assert.deepEqual(await expectRejection(`ApiKey EBTA_ABCDEFG_${SECRET}`, [createRow({})]), []);
  assert.deepEqual(await expectRejection(`ApiKey EBTA_ABCDEFGHJ_${SECRET}`, [createRow({})]), []);
});

test("rejects a wrong secret length", async () => {
  assert.deepEqual(await expectRejection(`ApiKey EBTA_${KEY_ID}_${SECRET.slice(0, 25)}`, [createRow({})]), []);
  assert.deepEqual(await expectRejection(`ApiKey EBTA_${KEY_ID}_${SECRET}0`, [createRow({})]), []);
});

test("rejects a key with no matching row", async () => {
  const calls = await expectRejection(AUTHORIZATION, []);
  assert.equal(calls.length, 1);
});

test("rejects a key whose lookup returns more than one row", async () => {
  const calls = await expectRejection(AUTHORIZATION, [createRow({}), createRow({})]);
  assert.equal(calls.length, 1);
});

test("rejects a revoked key", async () => {
  const calls = await expectRejection(AUTHORIZATION, [createRow({ revoked_at: "2026-03-12T00:00:00.000Z" })]);
  assert.equal(calls.length, 1);
});

test("rejects a key without an email", async () => {
  assert.equal((await expectRejection(AUTHORIZATION, [createRow({ email: null })])).length, 1);
  assert.equal((await expectRejection(AUTHORIZATION, [createRow({ email: "" })])).length, 1);
});

test("rejects a wrong secret", async () => {
  const wrongSecretHash = crypto.createHash("sha256").update(`${SECRET}X`).digest("hex");
  const calls = await expectRejection(AUTHORIZATION, [createRow({ key_hash: wrongSecretHash })]);
  assert.equal(calls.length, 1);
});
