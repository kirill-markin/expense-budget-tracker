import assert from "node:assert/strict";
import test from "node:test";

import { buildSystemInstructions, execQuery, TOOL_DESCRIPTION } from "./shared";

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
  assert.match(instructions, /single approval covers the full approved change set|approval covers the full approved change set/i);
  assert.match(instructions, /including the tiny probe and all remaining sequential batches/i);
  assert.match(instructions, /For INSERT .* try 1-3 literal representative rows first/i);
  assert.match(instructions, /at most 100 records per tool call/i);
  assert.match(instructions, /Prefer multiple sequential tool calls over one oversized batch/i);
  assert.match(instructions, /Do not pause only to ask the user to continue, proceed, or reconfirm for later batches/i);
  assert.match(instructions, /Only ask again if the requested change itself changes, new ambiguity appears, or execution fails/i);
  assert.match(instructions, /If the probe fails, stop, show the exact error, fix the SQL, and retry the tiny version/i);
  assert.match(instructions, /If the user explicitly delegates reasonable assumptions or says to use best judgment, best guess, decide for me, proceed, continue, or equivalent/i);
  assert.match(instructions, /treat unresolved account naming, category naming, and heuristic mapping choices as approved defaults for that import/i);
  assert.match(instructions, /Do: probe succeeds -> continue next batch immediately/i);
  assert.match(instructions, /Don't: probe succeeds -> ask "A or B" or request renewed approval unless execution failed or a new ambiguity appeared/i);
  assert.match(instructions, /If the user has explicitly delegated reasonable assumptions or best-guess decisions for this import, you may create the new category without asking again/i);
  assert.match(instructions, /Balance verification is required as an internal check/i);
  assert.match(instructions, /If the plan is internally consistent and the user already delegated reasonable assumptions, do not block execution on another confirmation/i);
  assert.match(instructions, /After approval, insert using a tiny representative probe first, then continue with the remaining approved data in sequential batches of at most 100 rows per tool call/i);
  assert.match(instructions, /Do not ask the user to continue between batches unless execution fails or a new ambiguity appears/i);
  assert.match(instructions, /explicit INSERT when the row is missing or an explicit UPDATE when the row already exists/i);
  assert.match(instructions, /first_day_of_week .*1\.\.7/i);
  assert.match(instructions, /Treat this protocol as chat-session-scoped, not message-scoped/i);
  assert.match(instructions, /reuse those results instead of repeating the same tool calls/i);
  assert.match(instructions, /previous tool result was explicitly interrupted or marked unknown/i);
  assert.match(instructions, /For CSV, XLS, and XLSX attachments, prefer the full raw tabular text already injected into the conversation/i);
  assert.match(instructions, /For PDF attachments, prefer the native file context first/i);
  assert.doesNotMatch(instructions, /After user confirms, insert with a single INSERT with multiple VALUES rows/i);
  assert.doesNotMatch(instructions, /web search/i);
  assert.doesNotMatch(instructions, /code interpreter/i);
});

test("buildSystemInstructions keeps import execution moving after a successful probe when assumptions were delegated", () => {
  const instructions = buildSystemInstructions("UTC");

  assert.match(instructions, /proceed, continue, or equivalent/i);
  assert.match(instructions, /approved defaults for that import/i);
  assert.match(instructions, /If the probe succeeds, immediately continue with the remaining approved data/i);
  assert.match(instructions, /Do not stop after a successful probe only because you want cleaner mapping, higher confidence, a nicer summary, or another confirmation/i);
  assert.match(instructions, /If the plan is internally consistent and the user already delegated reasonable assumptions, do not block execution on another confirmation/i);
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
  assert.match(TOOL_DESCRIPTION, /tiny representative probe/i);
  assert.match(TOOL_DESCRIPTION, /at most 100 records per tool call/i);
  assert.match(TOOL_DESCRIPTION, /approval .* full approved change set/i);
  assert.match(TOOL_DESCRIPTION, /including that probe and all remaining sequential batches/i);
  assert.match(TOOL_DESCRIPTION, /Do not pause only to ask the user to continue, proceed, or reconfirm for later batches/i);
  assert.match(TOOL_DESCRIPTION, /Only ask again if the requested change itself changes, new ambiguity appears, or execution fails/i);
  assert.match(TOOL_DESCRIPTION, /delegated reasonable assumptions or best-guess defaults/i);
  assert.match(TOOL_DESCRIPTION, /continue with later batches automatically instead of pausing for a cleaner plan or renewed approval/i);
});
