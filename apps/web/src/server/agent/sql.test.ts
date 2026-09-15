import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResult as PgQueryResult } from "pg";
import { getAgentSchemaHints } from "@expense-budget-tracker/agent-shared";
import {
  MAX_SQL_RESULT_CHARS,
  validateExpenseSql,
} from "@expense-budget-tracker/agent-shared/sql-policy";
import type { AgentAuthenticatedRequest } from "@/server/agent/apiKeyAuth";
import type { QueryFn } from "@/server/db/contextRunner";
import type { UserIdentity } from "@/server/users";

const AUTHENTICATED: AgentAuthenticatedRequest = {
  transport: "api_key",
  identity: {
    userId: "user-1",
    email: "user@example.com",
    emailVerified: true,
    cognitoStatus: "CONFIRMED",
    cognitoEnabled: true,
  },
  connectionId: "connection-1",
  label: "desktop",
  createdAt: "2026-04-01T00:00:00.000Z",
  lastUsedAt: null,
};

const OVERSIZED_ROW_COUNT = 100;
const FITTING_ROW_COUNT = 5;
const MUTATION_ROW_COUNT = 60;
const OVERSIZED_SQL = "SELECT entry_id, note FROM ledger_entries";
const FITTING_SQL = `SELECT entry_id, note FROM ledger_entries LIMIT ${String(FITTING_ROW_COUNT)}`;
const MUTATION_SQL = "DELETE FROM ledger_entries WHERE workspace_id = 'workspace-1' RETURNING entry_id, note";
const JOIN_SQL = `SELECT entries.entry_id, entries.note FROM ledger_entries AS entries JOIN account_metadata AS metadata ON metadata.account_id = entries.account_id LIMIT ${String(FITTING_ROW_COUNT)}`;
// A statement text this long leaves no room for the hints of the relation it
// touches, so only shedding them brings the result inside the budget.
const HINT_SHEDDING_SQL = `SELECT entry_id, note FROM ledger_entries WHERE note = '${"n".repeat(MAX_SQL_RESULT_CHARS - 1_000)}'`;

const createQueryResult = (
  command: string,
  rows: ReadonlyArray<Readonly<Record<string, string>>>,
): PgQueryResult => ({
  command,
  rowCount: rows.length,
  oid: 0,
  fields: [],
  rows: [...rows],
});

// 600-char notes, the row width that makes an ordinary 100-row read oversized.
const createRows = (rowCount: number): ReadonlyArray<Readonly<Record<string, string>>> =>
  Array.from({ length: rowCount }, (_value, index) => ({
    entry_id: `entry-${String(index)}`,
    note: "н".repeat(600),
  }));

// The restricted read path reads every SELECT through a cursor, so the fake
// answers DECLARE, FETCH, MOVE, and CLOSE the way PostgreSQL does.
const createCursorQueryFn = (): QueryFn => {
  let cursorRows: ReadonlyArray<Readonly<Record<string, string>>> = [];
  return async (sql): Promise<PgQueryResult> => {
    if (sql.startsWith("DELETE ")) {
      return createQueryResult("DELETE", createRows(MUTATION_ROW_COUNT));
    }
    if (sql.startsWith("DECLARE ")) {
      cursorRows = createRows(
        sql.includes(`LIMIT ${String(FITTING_ROW_COUNT)}`) ? FITTING_ROW_COUNT : OVERSIZED_ROW_COUNT,
      );
      return createQueryResult("DECLARE CURSOR", []);
    }
    if (sql.startsWith("FETCH FORWARD ")) {
      return createQueryResult("SELECT", cursorRows);
    }
    if (sql.startsWith("MOVE FORWARD ALL ")) {
      return createQueryResult("MOVE", []);
    }
    return createQueryResult("CLOSE CURSOR", []);
  };
};

// One test registers the module mocks and imports the module under test, the
// pattern the other module-mock tests in apps/web/src/server follow: the ESM
// module cache is shared across this file, so registrations made after the
// first import would not reach the imported module.
test("executeAgentSql bounds the result in characters, sheds hints before rows are lost for good, and keeps a cut mutation's affected row count", async (t): Promise<void> => {
  const queryFn = createCursorQueryFn();

  t.mock.module("@/server/db", {
    namedExports: {
      withRestrictedTrustedIdentityContext: async <T>(
        _identity: UserIdentity,
        _workspaceId: string,
        _statementTimeoutMs: number,
        callback: (restrictedQueryFn: QueryFn) => Promise<T>,
      ): Promise<T> => callback(queryFn),
    },
  });
  t.mock.module("@/server/workspaces", {
    namedExports: {
      getWorkspaceForTrustedIdentity: async (): Promise<Readonly<{
        workspaceId: string;
        name: string;
      }>> => ({
        workspaceId: "workspace-1",
        name: "Personal",
      }),
    },
  });

  const { executeAgentSql } = await import("./sql");

  const oversized = await executeAgentSql(
    AUTHENTICATED,
    "workspace-1",
    validateExpenseSql(OVERSIZED_SQL),
  );
  const fitting = await executeAgentSql(
    AUTHENTICATED,
    "workspace-1",
    validateExpenseSql(FITTING_SQL),
  );
  const mutation = await executeAgentSql(
    AUTHENTICATED,
    "workspace-1",
    validateExpenseSql(MUTATION_SQL),
  );
  const joined = await executeAgentSql(
    AUTHENTICATED,
    "workspace-1",
    validateExpenseSql(JOIN_SQL),
  );
  const hintShedding = await executeAgentSql(
    AUTHENTICATED,
    "workspace-1",
    validateExpenseSql(HINT_SHEDDING_SQL),
  );

  assert.ok(oversized);
  assert.ok(fitting);
  assert.ok(mutation);
  assert.ok(joined);
  assert.ok(hintShedding);
  const cutStatement = oversized.statements[0];
  const wholeStatement = fitting.statements[0];
  const mutationStatement = mutation.statements[0];
  assert.ok(cutStatement);
  assert.ok(wholeStatement);
  assert.ok(mutationStatement);

  assert.equal(oversized.limits.maxResultChars, MAX_SQL_RESULT_CHARS);
  assert.ok(JSON.stringify(oversized).length <= MAX_SQL_RESULT_CHARS);
  assert.ok(cutStatement.rows.length > 0);
  assert.ok(cutStatement.rows.length < OVERSIZED_ROW_COUNT);
  assert.equal(cutStatement.rowCount, cutStatement.rows.length);
  assert.equal(cutStatement.returnedRowCount, cutStatement.rows.length);
  assert.equal(cutStatement.totalRowCount, OVERSIZED_ROW_COUNT);
  assert.equal(cutStatement.truncated, true);

  assert.ok(JSON.stringify(fitting).length <= MAX_SQL_RESULT_CHARS);
  assert.equal(wholeStatement.rows.length, FITTING_ROW_COUNT);
  assert.equal(wholeStatement.rowCount, FITTING_ROW_COUNT);
  assert.equal(wholeStatement.returnedRowCount, FITTING_ROW_COUNT);
  assert.equal(wholeStatement.totalRowCount, FITTING_ROW_COUNT);
  assert.equal(wholeStatement.truncated, false);
  // A statement documents the relations it touched from the one shared source.
  assert.deepEqual(wholeStatement.hints, {
    ledger_entries: getAgentSchemaHints("ledger_entries"),
  });
  assert.equal(fitting.hintsDropped, false);

  assert.ok(JSON.stringify(mutation).length <= MAX_SQL_RESULT_CHARS);
  assert.ok(mutationStatement.rows.length > 0);
  assert.ok(mutationStatement.rows.length < MUTATION_ROW_COUNT);
  // The write committed, so its rowCount keeps naming the rows it affected.
  assert.equal(mutationStatement.rowCount, MUTATION_ROW_COUNT);
  assert.equal(mutationStatement.returnedRowCount, mutationStatement.rows.length);
  assert.equal(mutationStatement.totalRowCount, MUTATION_ROW_COUNT);
  assert.equal(mutationStatement.truncated, true);

  const joinedStatement = joined.statements[0];
  assert.ok(joinedStatement);
  // Every referenced relation gets its own entry, keyed by its own name, so a
  // statement that joins two of them documents both.
  assert.equal(joinedStatement.referencedRelations.length, 2);
  assert.deepEqual(joinedStatement.hints, {
    ledger_entries: getAgentSchemaHints("ledger_entries"),
    account_metadata: getAgentSchemaHints("account_metadata"),
  });

  const shedStatement = hintShedding.statements[0];
  assert.ok(shedStatement);
  // The hints are re-readable from GET /api/agent/schema, so a result that
  // cannot afford them sheds them and stays inside the budget it advertises.
  assert.ok(JSON.stringify(hintShedding).length <= MAX_SQL_RESULT_CHARS);
  assert.equal(hintShedding.hintsDropped, true);
  assert.equal(shedStatement.hints, undefined);
  assert.deepEqual(shedStatement.referencedRelations, ["ledger_entries"]);
  assert.equal(shedStatement.totalRowCount, OVERSIZED_ROW_COUNT);
});
