import assert from "node:assert/strict";
import test from "node:test";

import type { ToolCallContentPart } from "@/server/chat/types";
import {
  formatToolInput,
  formatToolOutput,
  getToolCallDisplayState,
} from "./toolCallDisplay";

const SQL = "SELECT account_id FROM accounts";

/** The registered SQL tools plus the name stored transcripts still carry. */
const SQL_TOOL_NAMES: ReadonlyArray<string> = ["sql_query", "sql_execute", "query_database"];

const translate = (key: string): string => key;

const createToolCall = (
  name: string,
  output: string,
): ToolCallContentPart => ({
  type: "tool_call",
  id: "tool-call-1",
  name,
  status: "completed",
  providerStatus: "completed",
  input: JSON.stringify({ sql: SQL }),
  output,
});

test("every SQL tool call surfaces its statement instead of the argument payload", (): void => {
  for (const name of SQL_TOOL_NAMES) {
    assert.equal(formatToolInput(name, JSON.stringify({ sql: SQL })), SQL);
  }

  const guideArguments = JSON.stringify({ topic: "sql_dialect" });
  assert.equal(
    formatToolInput("get_guide", guideArguments),
    JSON.stringify(JSON.parse(guideArguments), null, 2),
  );
});

test("every SQL tool call renders its stored result envelope", (): void => {
  const output = JSON.stringify({
    ok: true,
    data: { workspace: { workspaceId: "workspace-1", name: "Personal" }, statements: [] },
    instructions: "Use the returned rows.",
  });

  for (const name of SQL_TOOL_NAMES) {
    assert.equal(
      formatToolOutput(name, output),
      JSON.stringify(JSON.parse(output), null, 2),
    );
  }
});

test("a failed SQL tool call is labelled failed from its shared error envelope", (): void => {
  const failedOutput = JSON.stringify({
    ok: false,
    error: { code: "single_statement_required", message: "This SQL endpoint accepts exactly one statement" },
    instructions: "Send one statement per call.",
  });

  for (const name of SQL_TOOL_NAMES) {
    assert.equal(
      getToolCallDisplayState(createToolCall(name, failedOutput), translate).statusLabel,
      "chat.toolStatusFailed",
    );
    assert.equal(
      getToolCallDisplayState(createToolCall(name, "{\"ok\":true,\"data\":{},\"instructions\":\"\"}"), translate)
        .statusLabel,
      "chat.toolStatusCompleted",
    );
  }
});
