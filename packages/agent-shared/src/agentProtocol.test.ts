import assert from "node:assert/strict";
import test from "node:test";
import {
  ACCOUNT_BALANCES_QUERY_EXAMPLE,
  BUDGET_PLAN_VS_ACTUAL_QUERY_EXAMPLE,
  BUDGET_WINNING_ROWS_QUERY_EXAMPLE,
  FX_CONVERSION_QUERY_EXAMPLE,
  QUERY_RECIPES_GUIDE,
  RECENT_TRANSACTIONS_QUERY_EXAMPLE,
  SPENDING_BY_CATEGORY_QUERY_EXAMPLE,
  WRITING_DATA_GUIDE,
} from "./agentProtocol.js";
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

// The query recipes guide teaches these statements to production agents, so every
// one of them must keep parsing as a read under the restricted SQL policy.
const QUERY_RECIPE_STATEMENTS: ReadonlyArray<Readonly<{
  label: string;
  sql: string;
  referencedRelations: ReadonlyArray<string>;
}>> = [
  {
    label: "account balances",
    sql: ACCOUNT_BALANCES_QUERY_EXAMPLE,
    referencedRelations: ["ledger_entries"],
  },
  {
    label: "recent transactions",
    sql: RECENT_TRANSACTIONS_QUERY_EXAMPLE,
    referencedRelations: ["ledger_entries"],
  },
  {
    label: "spending by category",
    sql: SPENDING_BY_CATEGORY_QUERY_EXAMPLE,
    referencedRelations: ["ledger_entries"],
  },
  {
    label: "base budget plan vs actual",
    sql: BUDGET_PLAN_VS_ACTUAL_QUERY_EXAMPLE,
    referencedRelations: ["budget_lines", "ledger_entries", "fx_rates_daily"],
  },
  {
    label: "FX conversion at query time",
    sql: FX_CONVERSION_QUERY_EXAMPLE,
    referencedRelations: ["ledger_entries", "fx_rates_daily"],
  },
];

test("every query recipe the guide ships passes the restricted SQL policy as a read", (): void => {
  for (const { label, sql, referencedRelations } of QUERY_RECIPE_STATEMENTS) {
    assert.ok(
      QUERY_RECIPES_GUIDE.includes(sql),
      `Expected the query recipes guide to ship the ${label} statement`,
    );

    const validated = validateSingleReadOnlyExpenseSql(sql);
    assert.equal(validated.statements[0]?.isMutating, false, label);
    assert.deepEqual(validated.statements[0]?.referencedRelations, referencedRelations, label);
  }
});
