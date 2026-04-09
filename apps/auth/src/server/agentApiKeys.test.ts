import assert from "node:assert/strict";
import test from "node:test";

import { createAgentConnectionWithTransaction } from "./agentApiKeys.js";

type QueryCall = Readonly<{
  text: string;
  params: ReadonlyArray<unknown>;
}>;

const createTransactionRunner = (
  resolvedWorkspaceId: string | null,
  calls: Array<QueryCall>,
): (<T>(callback: (queryFn: (text: string, params: ReadonlyArray<unknown>) => Promise<Readonly<{ rows: ReadonlyArray<Readonly<Record<string, unknown>>> }>>) => Promise<T>) => Promise<T>) =>
  async <T>(callback: (queryFn: (text: string, params: ReadonlyArray<unknown>) => Promise<Readonly<{ rows: ReadonlyArray<Readonly<Record<string, unknown>>> }>>) => Promise<T>): Promise<T> =>
    callback(async (text: string, params: ReadonlyArray<unknown>) => {
      calls.push({ text, params });

      if (text === "SELECT auth.sync_authenticated_user($1, $2)") {
        return { rows: [] };
      }

      if (text === "SELECT auth.resolve_login_workspace_id($1, $2, $3) AS workspace_id") {
        return {
          rows: [{ workspace_id: resolvedWorkspaceId }],
        };
      }

      if (text.includes("INSERT INTO auth.agent_api_keys")) {
        return {
          rows: [{ connection_id: "connection-1", created_at: "2026-04-09T00:00:00.000Z" }],
        };
      }

      throw new Error(`Unexpected query: ${text}`);
    });

test("createAgentConnection stores selected workspace when resolver returns one", async (): Promise<void> => {
  const calls: Array<QueryCall> = [];

  await createAgentConnectionWithTransaction(
    "user-1",
    "user@example.com",
    "Desktop",
    createTransactionRunner("workspace-1", calls),
  );

  const insertCall = calls.find((call) => call.text.includes("INSERT INTO auth.agent_api_keys"));
  assert.ok(insertCall);
  assert.equal(insertCall.params[4], "workspace-1");
});

test("createAgentConnection leaves selected workspace null when resolver is ambiguous", async (): Promise<void> => {
  const calls: Array<QueryCall> = [];

  await createAgentConnectionWithTransaction(
    "user-1",
    "user@example.com",
    "Desktop",
    createTransactionRunner(null, calls),
  );

  const insertCall = calls.find((call) => call.text.includes("INSERT INTO auth.agent_api_keys"));
  assert.ok(insertCall);
  assert.equal(insertCall.params[4], null);
});
