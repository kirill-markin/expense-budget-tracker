import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResult } from "pg";
import type { QueryFn } from "@/server/db/contextRunner";
import { getChatSessionSnapshotWithQuery } from "./snapshotStore";

type RecordedQuery = Readonly<{
  text: string;
  params: ReadonlyArray<unknown>;
}>;

const createQueryResult = (
  rows: ReadonlyArray<unknown>,
): QueryResult => ({
  command: "SELECT",
  rowCount: rows.length,
  oid: 0,
  fields: [],
  rows: [...rows],
});

const createSessionRow = (
  status: "idle" | "running",
  activeRunId: string | null,
): Readonly<Record<string, string | null>> => ({
  session_id: "session-1",
  status,
  active_run_id: activeRunId,
  active_run_heartbeat_at: activeRunId === null
    ? null
    : "2026-07-27T10:00:01.000Z",
  main_content_invalidation_version: "0",
  updated_at: activeRunId === null
    ? "2026-07-27T10:00:00.000Z"
    : "2026-07-27T10:00:01.000Z",
});

test("snapshot locks the session before reading messages and uses the locked run state", async (): Promise<void> => {
  const turnId = "00000000-0000-4000-8000-000000000001";
  const recordedQueries: Array<RecordedQuery> = [];
  const queryFn: QueryFn = async (text, params): Promise<QueryResult> => {
    recordedQueries.push({ text, params });
    if (text.includes("FROM public.chat_sessions") && text.includes("FOR SHARE")) {
      return createQueryResult([createSessionRow("running", turnId)]);
    }
    if (text.includes("FROM public.chat_sessions")) {
      return createQueryResult([createSessionRow("idle", null)]);
    }
    if (text.includes("FROM public.chat_items")) {
      return createQueryResult([{
        item_id: turnId,
        session_id: "session-1",
        state: "completed",
        payload: {
          role: "user",
          content: [{ type: "text", text: "Persisted request" }],
        },
        created_at: "2026-07-27T10:00:01.000Z",
        updated_at: "2026-07-27T10:00:01.000Z",
      }]);
    }
    throw new Error(`Unexpected query: ${text}`);
  };

  const snapshot = await getChatSessionSnapshotWithQuery(
    queryFn,
    "user-1",
    "workspace-1",
    "session-1",
  );

  assert.equal(snapshot.runState, "running");
  assert.equal(snapshot.activeRunId, turnId);
  assert.equal(snapshot.messages[0]?.itemId, turnId);
  assert.equal(recordedQueries.length, 3);
  assert.match(recordedQueries[1].text, /FOR SHARE/);
  assert.match(recordedQueries[2].text, /FROM public\.chat_items/);
  assert.deepEqual(recordedQueries[1].params, ["session-1"]);
  assert.deepEqual(recordedQueries[2].params, ["session-1"]);
});
