import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResult } from "pg";
import type { QueryFn } from "@/server/db/contextRunner";
import {
  ChatSessionRunTransitionError,
  ChatTurnCancelledError,
} from "./shared";
import { lockUncancelledChatTurnForMutationWithQuery } from "./turnCancellationStore";

const createQueryResult = (
  rows: ReadonlyArray<Readonly<Record<string, string | null>>>,
): QueryResult => ({
  command: "SELECT",
  rowCount: rows.length,
  oid: 0,
  fields: [],
  rows: [...rows],
});

test("mutating SQL fencing locks the exact active turn before checking cancellation", async (): Promise<void> => {
  const queries: Array<string> = [];
  const queryFn: QueryFn = async (sql): Promise<QueryResult> => {
    queries.push(sql);
    if (queries.length === 1) {
      return createQueryResult([{
        session_id: "session-1",
        status: "running",
        active_run_id: "turn-1",
        active_run_heartbeat_at: "2026-07-27T10:00:00.000Z",
        main_content_invalidation_version: "0",
        updated_at: "2026-07-27T10:00:00.000Z",
      }]);
    }
    return createQueryResult([]);
  };

  await lockUncancelledChatTurnForMutationWithQuery(
    queryFn,
    "session-1",
    "turn-1",
  );

  assert.match(queries[0], /FOR UPDATE/u);
  assert.match(queries[1], /chat_turn_cancellations/u);
});

test("mutating SQL fencing rejects a tombstoned active turn", async (): Promise<void> => {
  let queryCount = 0;
  const queryFn: QueryFn = async (): Promise<QueryResult> => {
    queryCount += 1;
    return queryCount === 1
      ? createQueryResult([{
        session_id: "session-1",
        status: "running",
        active_run_id: "turn-1",
        active_run_heartbeat_at: "2026-07-27T10:00:00.000Z",
        main_content_invalidation_version: "0",
        updated_at: "2026-07-27T10:00:00.000Z",
      }])
      : createQueryResult([{ turn_id: "turn-1" }]);
  };

  await assert.rejects(
    () => lockUncancelledChatTurnForMutationWithQuery(
      queryFn,
      "session-1",
      "turn-1",
    ),
    ChatTurnCancelledError,
  );
});

test("a remote runtime reaching SQL after cancellation cannot mutate a terminal turn", async (): Promise<void> => {
  let queryCount = 0;
  const queryFn: QueryFn = async (): Promise<QueryResult> => {
    queryCount += 1;
    return createQueryResult([]);
  };

  await assert.rejects(
    () => lockUncancelledChatTurnForMutationWithQuery(
      queryFn,
      "session-1",
      "turn-1",
    ),
    ChatSessionRunTransitionError,
  );
  assert.equal(queryCount, 1);
});
