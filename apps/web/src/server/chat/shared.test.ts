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

test("buildSystemInstructions explains that browser chat already has an active workspace", () => {
  const instructions = buildSystemInstructions("Europe/Madrid");

  assert.match(instructions, /active workspace for this browser chat session is already selected by the app/i);
  assert.match(instructions, /Do not try to discover, list, or switch workspaces via SQL/i);
  assert.match(instructions, /narrow, vertical browser chat/i);
  assert.match(instructions, /Use plain text only/i);
  assert.match(instructions, /Do not use Markdown/i);
  assert.match(instructions, /Do not use .*tables/i);
});

test("TOOL_DESCRIPTION documents multi-statement scripts and statements output", () => {
  assert.match(TOOL_DESCRIPTION, /one or more .* statements separated by semicolons/i);
  assert.match(TOOL_DESCRIPTION, /"statements"/i);
});
