import assert from "node:assert/strict";
import test from "node:test";

import { buildSystemInstructions, execQuery, TOOL_DESCRIPTION } from "./shared";
import { buildOpenaiInstructions } from "./openai/agent/config";

test("execQuery rejects CTE shadowing of blocked relations before DB execution", async () => {
  await assert.rejects(
    execQuery(
      "WITH workspace_members AS (SELECT * FROM workspace_members) SELECT * FROM accounts",
      "user-1",
      "workspace-1",
    ),
    /Relation workspace_members is not allowed in chat queries/,
  );
});

test("execQuery rejects blocked TABLE syntax before DB execution", async () => {
  await assert.rejects(
    execQuery(
      "WITH recent AS (TABLE users) SELECT * FROM accounts",
      "user-1",
      "workspace-1",
    ),
    /Only SELECT, WITH, INSERT, UPDATE, and DELETE statements are allowed/,
  );
});

test("execQuery rejects ON CONFLICT before DB execution", async () => {
  await assert.rejects(
    execQuery(
      "INSERT INTO account_metadata (workspace_id, account_id, liquidity) VALUES ('workspace-1', 'a-checking-eur', 'high') ON CONFLICT (workspace_id, account_id) DO UPDATE SET liquidity = 'medium'",
      "user-1",
      "workspace-1",
    ),
    /ON CONFLICT is not supported in chat queries/,
  );
});

test("buildSystemInstructions explains that browser chat already has an active workspace", () => {
  const instructions = buildSystemInstructions("Europe/Madrid");

  assert.match(instructions, /active workspace for this browser chat session is already selected by the app/i);
  assert.match(instructions, /Do not try to discover, list, or switch workspaces via SQL/i);
  assert.match(instructions, /narrow, vertical browser chat/i);
  assert.match(instructions, /Use plain text only/i);
  assert.match(instructions, /Do not use Markdown/i);
  assert.match(instructions, /Do not use .*tables/i);
  assert.match(instructions, /Create pending, completed, and preauth rows/i);
  assert.match(instructions, /Treat preauth like pending because it often posts later/i);
  assert.match(instructions, /Skip declined, cancelled, and reverted rows/i);
  assert.doesNotMatch(instructions, /liquid \| illiquid/i);
  assert.match(instructions, /Do not proactively write optional sidecar tables/i);
  assert.match(instructions, /account_metadata \(optional sidecar table\)/i);
  assert.match(instructions, /high \| medium \| low/i);
  assert.match(instructions, /treats liquidity as high in balances and budget calculations/i);
  assert.match(instructions, /Restricted agent SQL does not support ON CONFLICT/i);
  assert.match(instructions, /For INSERT .* try 1-3 representative rows first/i);
  assert.match(instructions, /If the probe fails, stop, show the exact error, fix the SQL, and retry the tiny version/i);
  assert.match(instructions, /explicit INSERT when the row is missing or an explicit UPDATE when the row already exists/i);
  assert.match(instructions, /first_day_of_week .*1\.\.7/i);
  assert.match(instructions, /Treat this protocol as conversation-scoped, not message-scoped/i);
  assert.match(instructions, /reuse those results instead of repeating the same tool calls/i);
  assert.match(instructions, /previous tool result was explicitly interrupted or marked unknown/i);
  assert.match(instructions, /For CSV, XLS, and XLSX attachments, prefer the full raw tabular text already injected into the conversation/i);
  assert.match(instructions, /For PDF attachments, prefer the native file context first/i);
});

test("TOOL_DESCRIPTION documents multi-statement scripts and statements output", () => {
  assert.match(TOOL_DESCRIPTION, /one or more .* statements separated by semicolons/i);
  assert.match(TOOL_DESCRIPTION, /"ok": boolean/i);
  assert.match(TOOL_DESCRIPTION, /"tool": "query_database"/i);
  assert.match(TOOL_DESCRIPTION, /"sql": string \| null/i);
  assert.match(TOOL_DESCRIPTION, /"statements"/i);
  assert.match(TOOL_DESCRIPTION, /"error"\?: \{ "name": string, "message": string \}/i);
  assert.match(TOOL_DESCRIPTION, /optional sidecar/i);
  assert.match(TOOL_DESCRIPTION, /liquidity must be high, medium, or low/i);
  assert.match(TOOL_DESCRIPTION, /first_day_of_week SMALLINT/i);
  assert.match(TOOL_DESCRIPTION, /Restricted SQL does not support ON CONFLICT/i);
  assert.match(TOOL_DESCRIPTION, /tiny representative batch/i);
});

test("buildOpenaiInstructions describes durable CSV and PDF extraction behavior", () => {
  const instructions = buildOpenaiInstructions("Europe/Madrid", true);

  assert.match(instructions, /make important results durable/i);
  assert.match(instructions, /CSV, XLS, and XLSX attachments, prefer the raw tabular text already injected into the conversation/i);
  assert.match(instructions, /The original attached files also remain available as files/i);
  assert.match(instructions, /For PDF attachments, prefer the native file context first/i);
  assert.match(instructions, /print a compact text or JSON summary/i);
  assert.match(instructions, /print the complete extracted rows in logs/i);
  assert.match(instructions, /call capture_extracted_file_data/i);
  assert.match(instructions, /return a structured error payload as the tool result instead of throwing/i);
});
