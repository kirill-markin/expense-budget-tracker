import assert from "node:assert/strict";
import test from "node:test";

import { execQuery } from "./shared";

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
