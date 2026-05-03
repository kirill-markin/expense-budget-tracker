import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResult } from "pg";
import { ChatSessionRunTransitionError } from "@/server/chat/store";
import {
  completeChatSessionRunWithQuery,
  lockActiveChatSessionRunWithQuery,
  touchChatSessionHeartbeatWithQuery,
} from "@/server/chat/store/sessionStore";
import type { QueryFn } from "@/server/db/contextRunner";

const createQueryResult = (
  rows: ReadonlyArray<unknown>,
): QueryResult => ({
  command: "UPDATE",
  rowCount: rows.length,
  oid: 0,
  fields: [],
  rows: [...rows],
});

const createSessionRow = (
  status: "idle" | "running" | "interrupted",
  activeRunId: string | null,
): Readonly<Record<string, string | null>> => ({
  session_id: "session-1",
  status,
  active_run_id: activeRunId,
  active_run_heartbeat_at: activeRunId === null ? null : "2026-05-02T13:00:00.000Z",
  main_content_invalidation_version: "0",
  updated_at: "2026-05-02T13:00:00.000Z",
});

test("touchChatSessionHeartbeatWithQuery only touches heartbeat for the matching active run", async (): Promise<void> => {
  let queryText = "";
  let queryParams: ReadonlyArray<unknown> = [];
  const queryFn: QueryFn = async (text, params): Promise<QueryResult> => {
    queryText = text;
    queryParams = params;
    return createQueryResult([createSessionRow("running", "run-1")]);
  };

  const touched = await touchChatSessionHeartbeatWithQuery(
    queryFn,
    "session-1",
    "run-1",
    new Date("2026-05-02T13:00:00.000Z"),
  );

  assert.equal(touched, true);
  assert.equal(queryText.includes("status = $2"), false);
  assert.match(queryText, /SET active_run_heartbeat_at = \$3/);
  assert.match(queryText, /AND active_run_id = \$2/);
  assert.match(queryText, /AND status = 'running'/);
  assert.deepEqual(queryParams, ["session-1", "run-1", "2026-05-02T13:00:00.000Z"]);
});

test("completeChatSessionRunWithQuery requires the matching active run id", async (): Promise<void> => {
  let queryText = "";
  let queryParams: ReadonlyArray<unknown> = [];
  const queryFn: QueryFn = async (text, params): Promise<QueryResult> => {
    queryText = text;
    queryParams = params;
    return createQueryResult([createSessionRow("idle", null)]);
  };

  await completeChatSessionRunWithQuery(queryFn, "session-1", "run-1", "idle");

  assert.match(queryText, /SET status = \$3/);
  assert.match(queryText, /active_run_id = NULL/);
  assert.match(queryText, /active_run_heartbeat_at = NULL/);
  assert.match(queryText, /AND active_run_id = \$2/);
  assert.match(queryText, /AND status = 'running'/);
  assert.deepEqual(queryParams, ["session-1", "run-1", "idle"]);
});

test("lockActiveChatSessionRunWithQuery locks the matching running active run", async (): Promise<void> => {
  let queryText = "";
  let queryParams: ReadonlyArray<unknown> = [];
  const queryFn: QueryFn = async (text, params): Promise<QueryResult> => {
    queryText = text;
    queryParams = params;
    return createQueryResult([createSessionRow("running", "run-1")]);
  };

  const row = await lockActiveChatSessionRunWithQuery(
    queryFn,
    "session-1",
    "run-1",
    "test lock",
  );

  assert.equal(row.active_run_id, "run-1");
  assert.match(queryText, /WHERE session_id = \$1/);
  assert.match(queryText, /AND active_run_id = \$2/);
  assert.match(queryText, /AND status = 'running'/);
  assert.match(queryText, /FOR UPDATE/);
  assert.deepEqual(queryParams, ["session-1", "run-1"]);
});

test("completeChatSessionRunWithQuery raises when the guarded final transition updates no rows", async (): Promise<void> => {
  const queryFn: QueryFn = async (): Promise<QueryResult> =>
    createQueryResult([]);

  await assert.rejects(
    completeChatSessionRunWithQuery(queryFn, "session-1", "run-1", "idle"),
    (error: unknown): boolean =>
      error instanceof ChatSessionRunTransitionError
      && error.sessionId === "session-1"
      && error.activeRunId === "run-1"
      && error.targetState === "idle",
  );
});
