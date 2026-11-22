import assert from "node:assert/strict";
import test from "node:test";
import {
  createSqlExecutionDeadline,
  SQL_STATEMENT_TIMEOUT_MS,
} from "@expense-budget-tracker/agent-shared/sql-policy";
import type { OpenDaySurface } from "./db.js";
import { createOpenDayRecorder } from "./openDayRecorder.js";

const DEADLINE = createSqlExecutionDeadline(SQL_STATEMENT_TIMEOUT_MS, () => 0);

test("the recorder writes each person's surface once per UTC day and again on the next day", async (): Promise<void> => {
  const writes: Array<string> = [];
  let now = new Date("2026-11-22T23:59:59.000Z");
  const record = createOpenDayRecorder(
    async (userId: string, surface: OpenDaySurface): Promise<void> => {
      writes.push(`${userId}|${surface}`);
    },
    () => now,
  );

  await record("user-1", "api", DEADLINE);
  await record("user-1", "api", DEADLINE);
  await record("user-1", "mcp", DEADLINE);
  await record("user-2", "api", DEADLINE);
  now = new Date("2026-11-23T00:00:00.000Z");
  await record("user-1", "api", DEADLINE);
  await record("user-1", "api", DEADLINE);

  assert.deepEqual(writes, ["user-1|api", "user-1|mcp", "user-2|api", "user-1|api"]);
});

test("a failed write propagates and is attempted again by the next request", async (): Promise<void> => {
  let attempts = 0;
  const record = createOpenDayRecorder(
    async (): Promise<void> => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("connection terminated");
      }
    },
    () => new Date("2026-11-22T12:00:00.000Z"),
  );

  await assert.rejects(() => record("user-1", "api", DEADLINE), /connection terminated/u);
  await record("user-1", "api", DEADLINE);
  await record("user-1", "api", DEADLINE);

  assert.equal(attempts, 2);
});
