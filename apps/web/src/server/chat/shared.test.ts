import assert from "node:assert/strict";
import test from "node:test";
import { execQuery } from "@/server/chat/shared";

test("execQuery rejects function calls before reaching the database", async (): Promise<void> => {
  await assert.rejects(
    () => execQuery("SELECT now()", "user-1", "workspace-1"),
    (error: unknown) =>
      error instanceof Error
      && error.message === "Only allowlisted functions are supported in chat queries: SUM, COUNT, MIN, MAX, AVG, and COALESCE",
  );
});
