import assert from "node:assert/strict";
import test from "node:test";
import { BUDGET_WINNING_ROWS_QUERY_EXAMPLE, WRITING_DATA_GUIDE } from "./agentProtocol.js";
import { validateSingleReadOnlyExpenseSql } from "./sql-policy.js";

// Guards the composition itself: the single literal this guide replaced could not lose a section.
const WRITING_DATA_SECTION_HEADINGS: ReadonlyArray<string> = [
  "## Writing data",
  "### Discovery before writing",
  "### Entry shapes",
  "### Source rows and dates",
  "### Checklist for every entry",
  "### Budget rows",
  "### Questions",
  "### Approval and execution",
  "### Progress and resuming",
  "### Final verification",
];

test("the shared write guide composes every section exactly once and in order", (): void => {
  assert.deepEqual(
    WRITING_DATA_GUIDE.split("\n").filter((line) => line.startsWith("#")),
    WRITING_DATA_SECTION_HEADINGS,
  );
});

// The guide teaches this SQL shape to production agents, so the restricted SQL policy must keep accepting it.
test("the budget winning-rows example the guide ships passes the restricted SQL policy", (): void => {
  assert.ok(WRITING_DATA_GUIDE.includes(BUDGET_WINNING_ROWS_QUERY_EXAMPLE));

  const validated = validateSingleReadOnlyExpenseSql(BUDGET_WINNING_ROWS_QUERY_EXAMPLE);
  assert.deepEqual(validated.statements[0]?.referencedRelations, ["budget_lines"]);
  assert.equal(validated.statements[0]?.isMutating, false);
});
