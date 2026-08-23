import assert from "node:assert/strict";
import test from "node:test";
import {
  createSqlExecutionDeadline,
  executeExpenseSql,
  executeValidatedExpenseSqlWithinDeadline,
  getAllowedRelationNames,
  MAX_SQL_MUTATION_ROWS,
  MAX_SQL_RETURNED_ROWS,
  MAX_SQL_ROWS,
  MAX_SQL_SCRIPT_LENGTH,
  MAX_SQL_STATEMENTS,
  MCP_SQL_STATEMENT_TIMEOUT_MS,
  SQL_STATEMENT_TIMEOUT_MS,
  SqlExecutionDeadlineError,
  SqlPolicyError,
  validateExpenseSql,
  validateReadOnlyExpenseSql,
  validateSingleExpenseSql,
  validateSingleMutationExpenseSql,
  validateSingleReadOnlyExpenseSql,
  type RestrictedSqlExecutionRequest,
  type RestrictedSqlQueryResult,
  type RestrictedSqlResultRow,
} from "./sql-policy.js";

test("machine and MCP SQL deadlines leave response headroom below their gateways", (): void => {
  assert.equal(SQL_STATEMENT_TIMEOUT_MS, 25_000);
  assert.equal(MCP_SQL_STATEMENT_TIMEOUT_MS, 20_000);
  assert.ok(SQL_STATEMENT_TIMEOUT_MS < 29_000);
  assert.ok(MCP_SQL_STATEMENT_TIMEOUT_MS < SQL_STATEMENT_TIMEOUT_MS);
});

const assertFunctionCallRejected = (sql: string): void => {
  assert.throws(
    () => validateExpenseSql(sql),
    (error: unknown) =>
      error instanceof SqlPolicyError
      && error.code === "function_calls_not_allowed"
      && error.message.includes("Allowed functions: SUM, COUNT, MIN, MAX, AVG, COALESCE"),
  );
};

const assertPolicyError = (sql: string, expectedCode: SqlPolicyError["code"]): void => {
  assert.throws(
    () => validateExpenseSql(sql),
    (error: unknown) => error instanceof SqlPolicyError && error.code === expectedCode,
  );
};

const createCursorExecutor = (
  rowsByCursor: Readonly<Record<string, ReadonlyArray<RestrictedSqlResultRow>>>,
  requests: Array<RestrictedSqlExecutionRequest>,
): ((request: RestrictedSqlExecutionRequest) => Promise<RestrictedSqlQueryResult>) => {
  const positions = new Map<string, number>();

  return async (request): Promise<RestrictedSqlQueryResult> => {
    requests.push(request);
    assert.deepEqual(request.params, []);

    const declareMatch = /^DECLARE (api_sql_read_cursor_\d+) NO SCROLL CURSOR FOR /u.exec(request.sql);
    if (declareMatch !== null) {
      const cursorName = declareMatch[1];
      if (cursorName === undefined) {
        throw new TypeError("Expected an internal cursor name");
      }
      positions.set(cursorName, 0);
      return { command: "DECLARE", rows: [], rowCount: null };
    }

    const fetchMatch = /^FETCH FORWARD (\d+) FROM (api_sql_read_cursor_\d+)$/u.exec(request.sql);
    if (fetchMatch !== null) {
      const count = Number(fetchMatch[1]);
      const cursorName = fetchMatch[2];
      if (!Number.isSafeInteger(count) || cursorName === undefined) {
        throw new TypeError("Expected a valid cursor FETCH request");
      }
      const sourceRows = rowsByCursor[cursorName] ?? [];
      const position = positions.get(cursorName) ?? 0;
      const rows = sourceRows.slice(position, position + count);
      positions.set(cursorName, position + rows.length);
      return { command: "FETCH", rows, rowCount: rows.length };
    }

    const moveMatch = /^MOVE FORWARD ALL FROM (api_sql_read_cursor_\d+)$/u.exec(request.sql);
    if (moveMatch !== null) {
      const cursorName = moveMatch[1];
      if (cursorName === undefined) {
        throw new TypeError("Expected an internal cursor name");
      }
      const sourceRows = rowsByCursor[cursorName] ?? [];
      const position = positions.get(cursorName) ?? 0;
      positions.set(cursorName, sourceRows.length);
      return { command: "MOVE", rows: [], rowCount: sourceRows.length - position };
    }

    if (/^CLOSE api_sql_read_cursor_\d+$/u.test(request.sql)) {
      return { command: "CLOSE", rows: [], rowCount: null };
    }

    throw new TypeError(`Unexpected restricted SQL request: ${request.sql}`);
  };
};

test("validateExpenseSql allows allowlisted aggregate functions", (): void => {
  const acceptedSql: ReadonlyArray<string> = [
    "SELECT SUM(amount) AS balance FROM ledger_entries WHERE account_id = 'a-main-usd'",
    "SELECT COUNT(*) AS cnt FROM ledger_entries",
    "SELECT kind, COUNT(*) AS cnt, SUM(amount) AS total FROM ledger_entries GROUP BY kind",
    "SELECT account_id, currency, SUM(amount) AS balance FROM ledger_entries GROUP BY account_id, currency ORDER BY account_id",
    "SELECT COALESCE(SUM(amount), 0) AS balance FROM ledger_entries WHERE account_id = 'a-main-usd'",
    "SELECT MIN(ts) AS first_ts, MAX(ts) AS last_ts, AVG(amount) AS average_amount FROM ledger_entries",
  ];

  for (const sql of acceptedSql) {
    const validated = validateExpenseSql(sql);
    assert.equal(validated.statements.length, 1);
    assert.deepEqual(validated.statements[0]?.referencedRelations, ["ledger_entries"]);
  }
});

test("validateExpenseSql bounds script length and statement count", (): void => {
  assert.throws(
    () => validateExpenseSql(`SELECT '${"x".repeat(MAX_SQL_SCRIPT_LENGTH)}'`),
    (error: unknown) => error instanceof SqlPolicyError && error.code === "sql_script_too_long",
  );

  const sql = Array.from(
    { length: MAX_SQL_STATEMENTS + 1 },
    () => "SELECT account_id FROM accounts",
  ).join(";");
  assert.throws(
    () => validateExpenseSql(sql),
    (error: unknown) => error instanceof SqlPolicyError && error.code === "too_many_sql_statements",
  );
});

test("validateReadOnlyExpenseSql rejects direct writes", (): void => {
  const rejectedSql: ReadonlyArray<string> = [
    "UPDATE account_metadata SET liquidity = 'low' WHERE workspace_id = 'workspace-1'",
    "SELECT account_id FROM accounts; INSERT INTO workspace_settings (workspace_id, reporting_currency) VALUES ('workspace-1', 'USD')",
  ];

  for (const sql of rejectedSql) {
    assert.throws(
      () => validateReadOnlyExpenseSql(sql),
      (error: unknown) => error instanceof SqlPolicyError && error.code === "read_only_sql_required",
    );
  }
});

test("public validators reject data-modifying CTE bodies at every nesting depth", (): void => {
  const rejectedSql: ReadonlyArray<string> = [
    "WITH changed AS (INSERT INTO budget_lines (workspace_id) VALUES ('workspace-1') RETURNING *) SELECT * FROM changed",
    "WITH outer_rows AS (WITH changed AS (UPDATE account_metadata SET liquidity = 'low' RETURNING *) SELECT * FROM changed) SELECT * FROM outer_rows",
    "WITH outer_rows AS (WITH middle_rows AS (WITH changed AS (DELETE FROM ledger_entries RETURNING *) SELECT * FROM changed) SELECT * FROM middle_rows) SELECT * FROM outer_rows",
  ];
  const validators = [
    validateExpenseSql,
    validateReadOnlyExpenseSql,
    validateSingleExpenseSql,
    validateSingleReadOnlyExpenseSql,
  ] as const;

  for (const sql of rejectedSql) {
    for (const validate of validators) {
      assert.throws(
        () => validate(sql),
        (error: unknown) =>
          error instanceof SqlPolicyError
          && error.code === "unsupported_statement"
          && error.message === "Data-modifying CTE bodies are not supported; use SELECT, WITH, or VALUES in CTE bodies and move INSERT, UPDATE, or DELETE to the top-level statement. MERGE is not supported",
      );
    }
  }
});

test("public validators allow nested read-only SELECT and VALUES CTE bodies", (): void => {
  const acceptedSql: ReadonlyArray<string> = [
    "WITH outer_rows AS (WITH inner_rows AS (SELECT account_id FROM accounts) SELECT account_id FROM inner_rows) SELECT account_id FROM outer_rows",
    "WITH outer_rows AS (WITH middle_rows AS (WITH inner_rows(value) AS (VALUES (1), (2)) SELECT value FROM inner_rows) SELECT value FROM middle_rows) SELECT value FROM outer_rows",
  ];

  for (const sql of acceptedSql) {
    assert.equal(validateExpenseSql(sql).statements.length, 1);
    assert.equal(validateReadOnlyExpenseSql(sql).statements.length, 1);
    assert.equal(validateSingleExpenseSql(sql).statements.length, 1);
    assert.equal(validateSingleReadOnlyExpenseSql(sql).statements.length, 1);
  }
});

test("validateReadOnlyExpenseSql allows multi-statement read-only CTEs", (): void => {
  const validated = validateReadOnlyExpenseSql(
    "WITH totals AS (SELECT account_id, SUM(amount) AS balance FROM ledger_entries GROUP BY account_id) SELECT * FROM totals; WITH rows(value) AS (VALUES (1), (2)) SELECT value FROM rows",
  );

  assert.equal(validated.isReadOnly, true);
  assert.equal(validated.statements.length, 2);
  assert.equal(validated.statements.every((statement) => !statement.isMutating), true);
});

test("single-statement validators reject scripts without changing shared multi-statement validation", (): void => {
  const readScript = "SELECT account_id FROM accounts; SELECT rate FROM fx_rates_daily";
  const writeScript = "UPDATE account_metadata SET liquidity = 'low'; DELETE FROM budget_lines";

  assert.equal(validateReadOnlyExpenseSql(readScript).statements.length, 2);
  assert.equal(validateExpenseSql(writeScript).statements.length, 2);
  for (const validate of [validateSingleExpenseSql, validateSingleReadOnlyExpenseSql]) {
    assert.throws(
      () => validate(readScript),
      (error: unknown) => error instanceof SqlPolicyError && error.code === "single_statement_required",
    );
  }
  assert.throws(
    () => validateSingleExpenseSql(writeScript),
    (error: unknown) => error instanceof SqlPolicyError && error.code === "single_statement_required",
  );
});

test("validateSingleMutationExpenseSql accepts only a single mutation", (): void => {
  const acceptedSql: ReadonlyArray<string> = [
    "INSERT INTO budget_lines (workspace_id) VALUES ('workspace-1')",
    "UPDATE account_metadata SET liquidity = 'low' WHERE workspace_id = 'workspace-1'",
    "DELETE FROM ledger_entries WHERE workspace_id = 'workspace-1'",
    "WITH target AS (SELECT account_id FROM accounts) UPDATE account_metadata SET liquidity = 'low' FROM target WHERE account_metadata.account_id = target.account_id",
  ];
  for (const sql of acceptedSql) {
    const validated = validateSingleMutationExpenseSql(sql);
    assert.equal(validated.isMutation, true);
    assert.equal(validated.statements.length, 1);
    assert.equal(validated.statements[0]?.isMutating, true);
  }

  const rejectedSql: ReadonlyArray<string> = [
    "SELECT account_id FROM accounts",
    "WITH target AS (SELECT account_id FROM accounts) SELECT account_id FROM target",
  ];
  for (const sql of rejectedSql) {
    assert.throws(
      () => validateSingleMutationExpenseSql(sql),
      (error: unknown) =>
        error instanceof SqlPolicyError
        && error.code === "mutation_sql_required"
        && error.message.includes("send SELECT and WITH...SELECT to the query endpoint"),
    );
  }
});

test("restricted SQL rejects MERGE as the effective statement after WITH", (): void => {
  const sql = "WITH source AS (SELECT account_id FROM accounts) MERGE INTO account_metadata AS target USING source ON target.account_id = source.account_id WHEN MATCHED THEN UPDATE SET liquidity = 'low'";

  assertPolicyError(sql, "unsupported_statement");
  assert.throws(
    () => validateReadOnlyExpenseSql(sql),
    (error: unknown) => error instanceof SqlPolicyError && error.code === "unsupported_statement",
  );
});

test("restricted SQL rejects MERGE as an effective statement in nested CTE bodies", (): void => {
  const sql = "WITH outer_rows AS (WITH source AS (SELECT account_id FROM accounts) MERGE INTO account_metadata AS target USING source ON target.account_id = source.account_id WHEN MATCHED THEN UPDATE SET liquidity = 'low') SELECT * FROM outer_rows";

  assertPolicyError(sql, "unsupported_statement");
  assert.throws(
    () => validateReadOnlyExpenseSql(sql),
    (error: unknown) => error instanceof SqlPolicyError && error.code === "unsupported_statement",
  );
});

test("restricted SQL allows merge identifiers and string literals", (): void => {
  const validated = validateReadOnlyExpenseSql(
    "WITH merge AS (SELECT 'merge' AS merge FROM accounts) SELECT merge FROM merge",
  );

  assert.equal(validated.statements.length, 1);
  assert.equal(validated.statements[0]?.isMutating, false);
});

test("validateExpenseSql rejects non-allowlisted function calls in restricted SQL", (): void => {
  assertFunctionCallRejected("SELECT delete_workspace_for_current_user('x')");
  assertFunctionCallRejected("SELECT now()");
  assertFunctionCallRejected("SELECT account_id FROM ledger_entries ORDER BY lower(account_id)");
  assertFunctionCallRejected("SELECT pg_sleep(1)");
  assertFunctionCallRejected("WITH x AS (SELECT delete_workspace_for_current_user('x')) SELECT * FROM x");
  assertFunctionCallRejected("SELECT count(delete_workspace_for_current_user('x'))");
  assertFunctionCallRejected("INSERT INTO ledger_entries (event_id, ts, account_id, amount, currency, kind, workspace_id) VALUES (gen_random_uuid(), now(), 'a-main-usd', 1, 'USD', 'income', 'workspace-1')");
});

test("validateExpenseSql rejects attribute-notation function calls on indirection expressions", (): void => {
  const rejectedSql: ReadonlyArray<string> = [
    "SELECT entry_id FROM ledger_entries WHERE (amount).pg_sleep IS NULL",
    "UPDATE ledger_entries SET note = 'x' WHERE (amount).pg_sleep IS NULL",
    "DELETE FROM ledger_entries WHERE (amount).pg_sleep IS NULL",
    "SELECT entry_id FROM ledger_entries WHERE (currency).pg_get_viewdef IS NULL",
    "SELECT entry_id FROM ledger_entries WHERE (currency).to_regclass IS NULL",
    // Subscripted indirection terminates in `]` instead of `)`, but PostgreSQL
    // resolves the trailing field name through the same function lookup.
    "SELECT entry_id FROM ledger_entries WHERE (ARRAY[amount])[1].pg_sleep IS NULL",
    "SELECT workspace_id FROM workspace_settings WHERE (filtered_categories)[1].to_regclass IS NULL",
    // The construct is legal in every expression position, not only WHERE.
    "SELECT account_id FROM ledger_entries GROUP BY account_id HAVING sum(amount) > (amount).pg_sleep",
    "SELECT entry_id FROM ledger_entries ORDER BY entry_id, (amount).pg_sleep",
    "UPDATE ledger_entries SET note = 'x' WHERE entry_id = 'e1' RETURNING entry_id, (amount).pg_sleep",
    "WITH slow AS (SELECT entry_id FROM ledger_entries WHERE (amount).pg_sleep IS NULL) SELECT entry_id FROM slow",
    "SELECT entry_id FROM ledger_entries; SELECT entry_id FROM ledger_entries WHERE (amount).pg_sleep IS NULL",
  ];

  for (const sql of rejectedSql) {
    assert.throws(
      () => validateExpenseSql(sql),
      (error: unknown) =>
        error instanceof SqlPolicyError
        && error.code === "function_calls_not_allowed"
        && error.message.includes("Attribute-notation function calls"),
      sql,
    );
  }
});

test("validateExpenseSql still allows ordinary SQL without attribute notation", (): void => {
  const acceptedSql: ReadonlyArray<Readonly<{
    sql: string;
    relations: ReadonlyArray<string>;
  }>> = [
    {
      sql: "SELECT e.amount FROM ledger_entries e WHERE e.currency = 'EUR'",
      relations: ["ledger_entries"],
    },
    {
      sql: "SELECT entry_id FROM ledger_entries WHERE (amount) > 0",
      relations: ["ledger_entries"],
    },
    { sql: "SELECT sum(amount) FROM ledger_entries", relations: ["ledger_entries"] },
    // Plain subscripting and slices carry no field access, so the indirection
    // guard must leave them alone.
    {
      sql: "SELECT workspace_id FROM workspace_settings WHERE filtered_categories[1] = 'food'",
      relations: ["workspace_settings"],
    },
    {
      sql: "SELECT workspace_id FROM workspace_settings WHERE filtered_categories[1:2] = ARRAY['food']",
      relations: ["workspace_settings"],
    },
  ];

  for (const { sql, relations } of acceptedSql) {
    const validated = validateExpenseSql(sql);
    assert.equal(validated.statements.length, 1, sql);
    assert.deepEqual(validated.statements[0]?.referencedRelations, relations, sql);
  }

  const multiStatementCtes = validateReadOnlyExpenseSql(
    "WITH totals AS (SELECT account_id, SUM(amount) AS balance FROM ledger_entries GROUP BY account_id) SELECT * FROM totals; WITH rows(value) AS (VALUES (1), (2)) SELECT value FROM rows",
  );
  assert.equal(multiStatementCtes.statements.length, 2);
});

test("validateExpenseSql still rejects set_config before function allowlist checks", (): void => {
  assert.throws(
    () => validateExpenseSql("SELECT set_config('app.user_id', 'user-1', true)"),
    (error: unknown) =>
      error instanceof SqlPolicyError
      && error.code === "set_config_not_allowed"
      && error.message === "set_config() calls are not allowed",
  );
});

test("validateExpenseSql still allows direct relation queries without function calls", (): void => {
  const validated = validateExpenseSql("SELECT account_id FROM ledger_entries ORDER BY account_id LIMIT 1");
  assert.equal(validated.statements.length, 1);
  assert.deepEqual(validated.statements[0]?.referencedRelations, ["ledger_entries"]);
});

test("validateExpenseSql allows reads from SELECT-only relations", (): void => {
  const acceptedSql: ReadonlyArray<string> = [
    "SELECT account_id FROM accounts",
    "SELECT rate FROM fx_rates_raw",
    "SELECT rate FROM fx_rates_daily",
  ];

  for (const sql of acceptedSql) {
    const validated = validateExpenseSql(sql);
    assert.equal(validated.statements.length, 1);
    assert.equal(validated.statements[0]?.isMutating, false);
  }
});

test("validateExpenseSql rejects INSERT, UPDATE, and DELETE targets that are SELECT-only", (): void => {
  const rejectedSql: ReadonlyArray<string> = [
    "INSERT INTO accounts (account_id) VALUES ('a-main-usd')",
    "UPDATE accounts SET account_id = 'a-renamed-usd'",
    "DELETE FROM accounts WHERE account_id = 'a-main-usd'",
    "INSERT INTO fx_rates_raw (base_currency) VALUES ('EUR')",
    "UPDATE fx_rates_raw SET rate = 1",
    "DELETE FROM fx_rates_raw WHERE base_currency = 'EUR'",
    "INSERT INTO fx_rates_daily (base_currency) VALUES ('EUR')",
    "UPDATE fx_rates_daily SET rate = 1",
    "DELETE FROM fx_rates_daily WHERE base_currency = 'EUR'",
  ];

  for (const sql of rejectedSql) {
    assert.throws(
      () => validateExpenseSql(sql),
      (error: unknown) =>
        error instanceof SqlPolicyError
        && error.code === "read_only_relation_mutation_not_allowed"
        && error.message.includes("is SELECT-only"),
    );
  }
});

test("validateExpenseSql rejects data-modifying CTEs before relation-specific mutation checks", (): void => {
  assert.throws(
    () => validateExpenseSql(
      "WITH deleted_rates AS (DELETE FROM public.fx_rates_daily WHERE base_currency = 'EUR' RETURNING *) SELECT * FROM deleted_rates",
    ),
    (error: unknown) =>
      error instanceof SqlPolicyError
      && error.code === "unsupported_statement"
      && error.message === "Data-modifying CTE bodies are not supported; use SELECT, WITH, or VALUES in CTE bodies and move INSERT, UPDATE, or DELETE to the top-level statement. MERGE is not supported",
  );
});

test("validateExpenseSql rejects recursive CTE SEARCH and CYCLE clauses before hidden mutations", (): void => {
  const rejectedSql: ReadonlyArray<string> = [
    "WITH RECURSIVE rows(n) AS (SELECT 1) SEARCH DEPTH FIRST BY n SET ordercol UPDATE accounts SET account_id = 'a-renamed-usd'",
    "WITH RECURSIVE rows(n) AS (SELECT 1) SEARCH BREADTH FIRST BY n SET ordercol DELETE FROM fx_rates_raw WHERE base_currency = 'EUR'",
    "WITH RECURSIVE rows(n) AS (SELECT 1) SEARCH DEPTH FIRST BY n SET ordercol INSERT INTO fx_rates_daily (base_currency) VALUES ('EUR')",
    "WITH RECURSIVE rows(n) AS (SELECT 1) SEARCH DEPTH FIRST BY n SET ordercol, changed AS (UPDATE accounts SET account_id = 'a-renamed-usd' RETURNING *) SELECT * FROM changed",
    "WITH RECURSIVE rows(n) AS (SELECT 1) CYCLE n SET is_cycle USING cycle_path, changed AS (DELETE FROM fx_rates_raw WHERE base_currency = 'EUR' RETURNING *) SELECT * FROM changed",
  ];

  for (const sql of rejectedSql) {
    assert.throws(
      () => validateExpenseSql(sql),
      (error: unknown) =>
        error instanceof SqlPolicyError
        && error.code === "recursive_cte_search_cycle_not_allowed"
        && error.message === "Recursive CTE SEARCH and CYCLE clauses are not supported in restricted SQL",
    );
  }
});

test("validateExpenseSql allows SEARCH and CYCLE text in regular string literals", (): void => {
  const validated = validateExpenseSql(
    "SELECT 'SEARCH DEPTH FIRST' AS search_text, 'CYCLE path' AS cycle_text FROM accounts",
  );

  assert.equal(validated.statements.length, 1);
  assert.deepEqual(validated.statements[0]?.referencedRelations, ["accounts"]);
});

test("validateExpenseSql allows mutations of workspace-owned relations", (): void => {
  const acceptedSql: ReadonlyArray<string> = [
    "INSERT INTO ledger_entries (event_id, ts, account_id, amount, currency, kind, workspace_id) VALUES ('event-1', '2026-08-09', 'a-main-usd', 1, 'USD', 'income', 'workspace-1')",
    "UPDATE budget_lines SET planned_value = 100 WHERE workspace_id = 'workspace-1'",
    "DELETE FROM workspace_settings WHERE workspace_id = 'workspace-1'",
    "WITH source AS (SELECT account_id FROM accounts) UPDATE account_metadata SET liquidity = 'low' FROM source WHERE account_metadata.account_id = source.account_id",
  ];

  for (const sql of acceptedSql) {
    const validated = validateExpenseSql(sql);
    assert.equal(validated.statements.length, 1);
    assert.equal(validated.statements[0]?.isMutating, true);
  }
});

test("validateExpenseSql validates every DELETE USING source relation", (): void => {
  const rejectedSql: ReadonlyArray<string> = [
    "DELETE FROM ledger_entries USING pg_catalog.pg_class AS catalog WHERE ledger_entries.account_id = catalog.relname",
    "DELETE FROM ledger_entries USING pg_catalog.pg_class AS catalog, accounts AS allowed_accounts WHERE ledger_entries.account_id = allowed_accounts.account_id",
    "DELETE FROM ledger_entries USING accounts AS allowed_accounts, pg_catalog.pg_class AS catalog WHERE ledger_entries.account_id = allowed_accounts.account_id",
    "DELETE FROM ledger_entries AS entries USING accounts AS allowed_accounts JOIN pg_catalog.pg_class AS catalog ON allowed_accounts.account_id = catalog.relname WHERE entries.account_id = allowed_accounts.account_id",
    "DELETE FROM ledger_entries AS entries USING (accounts AS allowed_accounts JOIN pg_catalog.pg_class AS catalog ON allowed_accounts.account_id = catalog.relname) WHERE entries.account_id = allowed_accounts.account_id",
    "DELETE FROM ledger_entries AS entries USING (accounts AS allowed_accounts JOIN (workspace_settings AS settings JOIN pg_catalog.pg_class AS catalog ON settings.workspace_id = catalog.relname) ON allowed_accounts.account_id = catalog.relname) WHERE entries.account_id = allowed_accounts.account_id",
    "DELETE FROM ledger_entries AS entries USING ((SELECT relname FROM pg_catalog.pg_class)) AS catalog WHERE entries.account_id = catalog.relname",
    "WITH source AS (SELECT relname FROM pg_catalog.pg_class) DELETE FROM ledger_entries AS entries USING source AS catalog WHERE entries.account_id = catalog.relname",
    "DELETE FROM ledger_entries AS entries USING workspace_settings AS settings WHERE (EXISTS (SELECT 1 FROM (pg_catalog.pg_class AS catalog JOIN accounts AS allowed_accounts ON catalog.relname = allowed_accounts.account_id)))",
    "DELETE FROM ledger_entries AS entries USING workspace_settings AS settings WHERE entries.account_id IN (SELECT allowed_accounts.account_id FROM (pg_catalog.pg_class AS catalog JOIN accounts AS allowed_accounts ON catalog.relname = allowed_accounts.account_id))",
    "DELETE FROM ledger_entries AS entries USING workspace_settings AS settings WHERE entries.account_id = (SELECT allowed_accounts.account_id FROM (pg_catalog.pg_class AS catalog JOIN accounts AS allowed_accounts ON catalog.relname = allowed_accounts.account_id))",
    "DELETE FROM ledger_entries AS entries USING (SELECT workspace_id FROM workspace_settings UNION SELECT allowed_accounts.workspace_id FROM (pg_catalog.pg_class AS catalog JOIN accounts AS allowed_accounts ON catalog.relname = allowed_accounts.account_id)) AS source WHERE entries.workspace_id = source.workspace_id",
    "DELETE FROM ledger_entries AS entries USING (SELECT workspace_id AS where, workspace_id AS returning FROM workspace_settings) AS source JOIN account_metadata AS metadata ON source.where = metadata.workspace_id AND source.returning = metadata.workspace_id JOIN pg_catalog.pg_class AS catalog ON catalog.relname = metadata.account_id WHERE entries.workspace_id = source.where",
  ];

  for (const sql of rejectedSql) {
    assertPolicyError(sql, "relation_not_allowed");
  }

  assertFunctionCallRejected(
    "DELETE FROM ledger_entries AS entries USING generate_series(1, 2) AS generated WHERE entries.amount = generated",
  );
  assertFunctionCallRejected(
    "DELETE FROM ledger_entries AS entries USING (SELECT lower(account_id) AS account_id FROM accounts) AS lowered WHERE entries.account_id = lowered.account_id",
  );
  assertFunctionCallRejected(
    "DELETE FROM ledger_entries AS entries USING workspace_settings AS settings JOIN account_metadata AS metadata ON lower(settings.workspace_id) = metadata.workspace_id WHERE entries.workspace_id = settings.workspace_id",
  );
});

test("validateExpenseSql allows valid DELETE USING source variants", (): void => {
  const acceptedSql: ReadonlyArray<Readonly<{
    sql: string;
    referencedRelations: ReadonlyArray<string>;
  }>> = [
    {
      sql: "DELETE FROM ledger_entries AS entries USING public.workspace_settings AS settings, account_metadata AS metadata WHERE entries.workspace_id = settings.workspace_id AND entries.account_id = metadata.account_id",
      referencedRelations: ["ledger_entries", "workspace_settings", "account_metadata"],
    },
    {
      sql: "WITH source AS (SELECT workspace_id FROM workspace_settings) DELETE FROM ledger_entries AS entries USING source AS settings WHERE entries.workspace_id = settings.workspace_id",
      referencedRelations: ["workspace_settings", "ledger_entries"],
    },
    {
      sql: "DELETE FROM ledger_entries AS entries USING (SELECT workspace_id FROM workspace_settings) AS settings WHERE entries.workspace_id = settings.workspace_id",
      referencedRelations: ["ledger_entries", "workspace_settings"],
    },
    {
      sql: "DELETE FROM ledger_entries AS entries USING public.workspace_settings AS settings JOIN account_metadata AS metadata ON COALESCE(settings.workspace_id, '') = metadata.workspace_id WHERE entries.workspace_id = settings.workspace_id",
      referencedRelations: ["ledger_entries", "workspace_settings", "account_metadata"],
    },
    {
      sql: "DELETE FROM ledger_entries AS entries USING workspace_settings AS settings JOIN account_metadata AS metadata USING (workspace_id) WHERE entries.workspace_id = settings.workspace_id",
      referencedRelations: ["ledger_entries", "workspace_settings", "account_metadata"],
    },
    {
      sql: "DELETE FROM ledger_entries AS entries USING (workspace_settings AS settings JOIN account_metadata AS metadata USING (workspace_id)) WHERE entries.workspace_id = settings.workspace_id",
      referencedRelations: ["ledger_entries", "workspace_settings", "account_metadata"],
    },
    {
      sql: "DELETE FROM ledger_entries AS entries USING ((SELECT workspace_id FROM public.workspace_settings)) AS settings WHERE entries.workspace_id = settings.workspace_id",
      referencedRelations: ["ledger_entries", "workspace_settings"],
    },
    {
      sql: "DELETE FROM ledger_entries AS entries USING ((SELECT workspace_id FROM workspace_settings JOIN account_metadata USING (workspace_id))) AS settings WHERE entries.workspace_id = settings.workspace_id",
      referencedRelations: ["ledger_entries", "workspace_settings", "account_metadata"],
    },
    {
      sql: "DELETE FROM ledger_entries AS entries USING ((WITH source AS (SELECT workspace_id FROM workspace_settings JOIN account_metadata USING (workspace_id)) SELECT workspace_id FROM source)) AS settings WHERE entries.workspace_id = settings.workspace_id",
      referencedRelations: ["ledger_entries", "workspace_settings", "account_metadata"],
    },
    {
      sql: "DELETE FROM ledger_entries AS entries USING workspace_settings AS settings WHERE entries.workspace_id = settings.workspace_id RETURNING entries.account_id, entries.currency",
      referencedRelations: ["ledger_entries", "workspace_settings"],
    },
    {
      sql: "DELETE FROM ledger_entries AS entries USING workspace_settings AS settings WHERE (EXISTS (SELECT 1 FROM (account_metadata AS metadata JOIN accounts AS allowed_accounts USING (account_id))))",
      referencedRelations: ["ledger_entries", "workspace_settings", "account_metadata", "accounts"],
    },
    {
      sql: "DELETE FROM ledger_entries AS entries USING workspace_settings AS settings WHERE entries.account_id IN (SELECT allowed_accounts.account_id FROM (account_metadata AS metadata JOIN accounts AS allowed_accounts USING (account_id)))",
      referencedRelations: ["ledger_entries", "workspace_settings", "account_metadata", "accounts"],
    },
    {
      sql: "DELETE FROM ledger_entries AS entries USING workspace_settings AS settings WHERE entries.account_id = (SELECT allowed_accounts.account_id FROM (account_metadata AS metadata JOIN accounts AS allowed_accounts USING (account_id)))",
      referencedRelations: ["ledger_entries", "workspace_settings", "account_metadata", "accounts"],
    },
    {
      sql: "DELETE FROM ledger_entries AS entries USING (SELECT workspace_id FROM workspace_settings UNION SELECT allowed_accounts.workspace_id FROM (account_metadata AS metadata JOIN accounts AS allowed_accounts USING (account_id))) AS source WHERE entries.workspace_id = source.workspace_id",
      referencedRelations: ["ledger_entries", "workspace_settings", "account_metadata", "accounts"],
    },
    {
      sql: "DELETE FROM ledger_entries AS entries USING (SELECT workspace_id AS where, workspace_id AS returning FROM workspace_settings) AS source JOIN account_metadata AS metadata ON source.where = metadata.workspace_id AND source.returning = metadata.workspace_id WHERE entries.workspace_id = source.where",
      referencedRelations: ["ledger_entries", "workspace_settings", "account_metadata"],
    },
  ];

  for (const { sql, referencedRelations } of acceptedSql) {
    const validated = validateSingleMutationExpenseSql(sql);
    assert.equal(validated.statements[0]?.isMutating, true);
    assert.deepEqual(validated.statements[0]?.referencedRelations, referencedRelations);
  }
});

test("validateExpenseSql allows a mutable target to read from a SELECT-only source", (): void => {
  const validated = validateExpenseSql(
    "INSERT INTO ledger_entries (event_id, ts, account_id, amount, currency, kind, workspace_id) SELECT 'event-1', '2026-08-09', 'a-main-usd', rate, quote_currency, 'income', 'workspace-1' FROM fx_rates_daily WHERE base_currency = 'EUR'",
  );

  assert.equal(validated.statements[0]?.isMutating, true);
  assert.deepEqual(validated.statements[0]?.referencedRelations, ["ledger_entries", "fx_rates_daily"]);
});

test("validateExpenseSql allows grouping and derived subqueries after SQL keywords", (): void => {
  const acceptedSql: ReadonlyArray<string> = [
    "SELECT account_id FROM ledger_entries WHERE account_id = 'a-main-usd' AND (kind = 'expense')",
    "SELECT account_id FROM ledger_entries WHERE (kind = 'expense')",
    "SELECT account_id FROM ledger_entries WHERE kind = 'expense' OR (kind = 'income')",
    "SELECT account_id FROM (SELECT account_id FROM ledger_entries) AS entries",
    "SELECT entries.account_id FROM ledger_entries AS entries JOIN (SELECT account_id FROM accounts) AS account_rows ON entries.account_id = account_rows.account_id",
  ];

  for (const sql of acceptedSql) {
    assert.equal(validateExpenseSql(sql).statements.length, 1);
  }
});

test("validateExpenseSql inspects functions nested in grouping and derived subqueries", (): void => {
  const rejectedSql: ReadonlyArray<string> = [
    "SELECT account_id FROM ledger_entries WHERE account_id = 'a-main-usd' AND (lower(kind) = 'expense')",
    "SELECT account_id FROM ledger_entries WHERE (lower(kind) = 'expense')",
    "SELECT account_id FROM ledger_entries WHERE kind = 'expense' OR (lower(kind) = 'income')",
    "SELECT account_id FROM (SELECT lower(account_id) AS account_id FROM ledger_entries) AS entries",
    "SELECT entries.account_id FROM ledger_entries AS entries JOIN (SELECT lower(account_id) AS account_id FROM accounts) AS account_rows ON entries.account_id = account_rows.account_id",
  ];

  for (const sql of rejectedSql) {
    assertFunctionCallRejected(sql);
  }
});

test("validateExpenseSql rejects schema-qualified grammar keywords as function calls", (): void => {
  const rejectedSql: ReadonlyArray<string> = [
    "SELECT custom.and(1)",
    "SELECT custom.or(1)",
    "SELECT custom.where(1)",
    "SELECT custom.from(1)",
    "SELECT custom.join(1)",
    "DELETE FROM ledger_entries WHERE custom.using(1) = 1",
  ];

  for (const sql of rejectedSql) {
    assertFunctionCallRejected(sql);
  }
});

test("validateExpenseSql inspects relations nested in grouping and derived subqueries", (): void => {
  const rejectedSql: ReadonlyArray<string> = [
    "SELECT account_id FROM ledger_entries WHERE account_id = 'a-main-usd' AND (EXISTS (SELECT 1 FROM private_accounts))",
    "SELECT account_id FROM ledger_entries WHERE (EXISTS (SELECT 1 FROM private_accounts))",
    "SELECT account_id FROM ledger_entries WHERE kind = 'expense' OR (EXISTS (SELECT 1 FROM private_accounts))",
    "SELECT account_id FROM (SELECT account_id FROM private_accounts) AS entries",
    "SELECT entries.account_id FROM ledger_entries AS entries JOIN (SELECT account_id FROM private_accounts) AS account_rows ON entries.account_id = account_rows.account_id",
  ];

  for (const sql of rejectedSql) {
    assertPolicyError(sql, "relation_not_allowed");
  }
});

test("validateExpenseSql rejects parenthesized joined tables", (): void => {
  const rejectedSql: ReadonlyArray<string> = [
    "SELECT * FROM (private_accounts JOIN accounts ON true)",
    "SELECT * FROM accounts JOIN (private_accounts JOIN ledger_entries ON true) ON true",
  ];

  for (const sql of rejectedSql) {
    assertFunctionCallRejected(sql);
  }
});

test("validateExpenseSql allows comment and quote markers inside string literals", (): void => {
  const acceptedSql: ReadonlyArray<string> = [
    "SELECT '\"' AS marker FROM ledger_entries",
    "SELECT '--' AS marker FROM ledger_entries",
    "SELECT '/*' AS marker FROM ledger_entries",
    "SELECT 'customer''s \" -- /*' AS marker FROM ledger_entries",
    "SELECT 'E''value' AS marker FROM ledger_entries",
    "SELECT '$5 and $tag$' AS marker FROM ledger_entries",
  ];

  for (const sql of acceptedSql) {
    assert.equal(validateExpenseSql(sql).statements.length, 1);
  }
});

test("validateExpenseSql rejects syntax markers outside string literals with specific errors", (): void => {
  assertPolicyError("SELECT \"account_id\" FROM ledger_entries", "quoted_identifiers_not_allowed");
  assertPolicyError("SELECT account_id FROM ledger_entries -- comment", "sql_comments_not_allowed");
  assertPolicyError("SELECT /* comment */ account_id FROM ledger_entries", "sql_comments_not_allowed");
  assertPolicyError("SELECT $tag$value$tag$ FROM ledger_entries", "dollar_quoted_strings_not_allowed");
  assertPolicyError("SELECT 'unterminated FROM ledger_entries", "unterminated_string_literal");
});

test("validateExpenseSql rejects dollar signs in unquoted function identifiers", (): void => {
  assertPolicyError("SELECT evil$and(1)", "dollar_quoted_strings_not_allowed");
  assertPolicyError("SELECT public.evil$and(1)", "dollar_quoted_strings_not_allowed");
});

test("validateExpenseSql rejects escape strings before they can conceal restricted syntax", (): void => {
  const rejectedSql: ReadonlyArray<string> = [
    "SELECT E'a\\'b' FROM \"ledger_entries\" WHERE 'x' = E'c\\'d'",
    "SELECT e'a\\'b' /* comment */ FROM ledger_entries WHERE 'x' = e'c\\'d'",
    "SELECT E'a\\'b' FROM private_accounts WHERE 'x' = E'c\\'d'",
    "SELECT e'a\\'b', pg_sleep(1), e'c\\'d'",
  ];

  for (const sql of rejectedSql) {
    assertPolicyError(sql, "escape_string_literals_not_allowed");
  }
});

test("validateExpenseSql allows typed literals with type names ending in e", (): void => {
  const acceptedSql: ReadonlyArray<string> = [
    "SELECT DATE'2026-08-09' AS report_date FROM ledger_entries",
    "SELECT TIME'12:00:00' AS report_time FROM ledger_entries",
  ];

  for (const sql of acceptedSql) {
    assert.equal(validateExpenseSql(sql).statements.length, 1);
  }
});

test("restricted SQL policy does not expose internal or removed relations", (): void => {
  assert.deepEqual(
    getAllowedRelationNames().filter((relationName) => relationName.startsWith("community")),
    [],
  );

  const rejectedRelations: ReadonlyArray<string> = [
    "SELECT * FROM community.monthly_category_shares",
    "SELECT * FROM monthly_category_shares",
    "SELECT * FROM budget_comments",
  ];

  for (const sql of rejectedRelations) {
    assert.throws(
      () => validateExpenseSql(sql),
      (error: unknown) =>
        error instanceof SqlPolicyError && error.code === "relation_not_allowed",
    );
  }

  assert.throws(
    () => validateExpenseSql("SELECT * FROM community.read_public_monthly_category_share('token', '2025-01-01', '2025-12-01')"),
    (error: unknown) =>
      error instanceof SqlPolicyError && error.code === "function_calls_not_allowed",
  );
});

test("executeExpenseSql reports truncation metadata without removing rowCount", async (): Promise<void> => {
  const sourceRows: ReadonlyArray<Readonly<Record<string, unknown>>> = Array.from(
    { length: MAX_SQL_ROWS + 1 },
    (_value, index) => ({ account_id: `account-${String(index)}` }),
  );

  const requests: Array<RestrictedSqlExecutionRequest> = [];
  const sql = "SELECT account_id FROM ledger_entries ORDER BY account_id";
  const executed = await executeExpenseSql(sql, createCursorExecutor({
    api_sql_read_cursor_1: sourceRows,
  }, requests));

  const statement = executed.statements[0];
  assert.equal(statement?.rowCount, MAX_SQL_ROWS);
  assert.equal(statement?.returnedRowCount, MAX_SQL_ROWS);
  assert.equal(statement?.totalRowCount, MAX_SQL_ROWS + 1);
  assert.equal(statement?.truncated, true);
  assert.deepEqual(requests.map((request) => request.sql), [
    `DECLARE api_sql_read_cursor_1 NO SCROLL CURSOR FOR ${sql}`,
    `FETCH FORWARD ${String(MAX_SQL_ROWS + 1)} FROM api_sql_read_cursor_1`,
    "MOVE FORWARD ALL FROM api_sql_read_cursor_1",
    "CLOSE api_sql_read_cursor_1",
  ]);
  assert.equal(requests[0]?.sql.endsWith("ORDER BY account_id"), true);
});

test("deadline execution propagates one cumulatively decreasing budget to every cursor command", async (): Promise<void> => {
  let currentTimeMs = 1_000;
  const receivedTimeouts: Array<number> = [];
  const requests: Array<RestrictedSqlExecutionRequest> = [];
  const cursorExecutor = createCursorExecutor({
    api_sql_read_cursor_1: [{ account_id: "account-1" }],
  }, requests);
  const commandDurations = [2_000, 5_000, 3_000, 0] as const;

  await executeValidatedExpenseSqlWithinDeadline(
    validateExpenseSql("SELECT account_id FROM accounts ORDER BY account_id"),
    createSqlExecutionDeadline(MCP_SQL_STATEMENT_TIMEOUT_MS, () => currentTimeMs),
    async (request, statementTimeoutMs) => {
      const commandIndex = receivedTimeouts.length;
      receivedTimeouts.push(statementTimeoutMs);
      const result = await cursorExecutor(request);
      currentTimeMs += commandDurations[commandIndex] ?? 0;
      return result;
    },
  );

  assert.deepEqual(receivedTimeouts, [20_000, 18_000, 13_000, 10_000]);
  assert.deepEqual(requests.map((request) => request.sql), [
    "DECLARE api_sql_read_cursor_1 NO SCROLL CURSOR FOR SELECT account_id FROM accounts ORDER BY account_id",
    `FETCH FORWARD ${String(MAX_SQL_ROWS + 1)} FROM api_sql_read_cursor_1`,
    "MOVE FORWARD ALL FROM api_sql_read_cursor_1",
    "CLOSE api_sql_read_cursor_1",
  ]);
});

test("deadline execution stops before dispatching a cursor command with no remaining budget", async (): Promise<void> => {
  let currentTimeMs = 1_000;
  const requests: Array<RestrictedSqlExecutionRequest> = [];
  const cursorExecutor = createCursorExecutor({
    api_sql_read_cursor_1: [{ account_id: "account-1" }],
  }, requests);

  await assert.rejects(
    () => executeValidatedExpenseSqlWithinDeadline(
      validateExpenseSql("SELECT account_id FROM accounts"),
      createSqlExecutionDeadline(MCP_SQL_STATEMENT_TIMEOUT_MS, () => currentTimeMs),
      async (request) => {
        const result = await cursorExecutor(request);
        currentTimeMs += MCP_SQL_STATEMENT_TIMEOUT_MS;
        return result;
      },
    ),
    (error: unknown) =>
      error instanceof SqlExecutionDeadlineError
      && error.timeoutMs === MCP_SQL_STATEMENT_TIMEOUT_MS
      && error.message.includes("total deadline"),
  );

  assert.deepEqual(requests.map((request) => request.sql), [
    "DECLARE api_sql_read_cursor_1 NO SCROLL CURSOR FOR SELECT account_id FROM accounts",
  ]);
});

test("executeExpenseSql bounds reads before execution and across the whole request", async (): Promise<void> => {
  const requestedLimits: Array<number> = [];
  const requests: Array<RestrictedSqlExecutionRequest> = [];
  const firstRows = Array.from({ length: 80 }, (_value, index) => ({ value: index }));
  const secondRows = Array.from({ length: 75 }, (_value, index) => ({ value: index }));
  const cursorExecutor = createCursorExecutor({
    api_sql_read_cursor_1: firstRows,
    api_sql_read_cursor_2: secondRows,
  }, requests);
  const executed = await executeExpenseSql(
    "SELECT account_id FROM accounts; SELECT rate FROM fx_rates_daily",
    async (request) => {
      const fetchMatch = /^FETCH FORWARD (\d+) FROM /u.exec(request.sql);
      if (fetchMatch?.[1] !== undefined) {
        requestedLimits.push(Number(fetchMatch[1]) - 1);
      }
      return cursorExecutor(request);
    },
  );

  assert.deepEqual(requestedLimits, [MAX_SQL_ROWS, MAX_SQL_RETURNED_ROWS - 80]);
  assert.deepEqual(executed.statements.map((statement) => statement.returnedRowCount), [80, 20]);
  assert.deepEqual(executed.statements.map((statement) => statement.totalRowCount), [80, 75]);
  assert.equal(executed.statements[1]?.truncated, true);
});

test("executeExpenseSql derives exact totals when request row capacity is exhausted", async (): Promise<void> => {
  const requests: Array<RestrictedSqlExecutionRequest> = [];
  const firstRows = Array.from({ length: MAX_SQL_RETURNED_ROWS }, (_value, index) => ({ value: index }));
  const secondRows = [{ value: 1 }, { value: 2 }, { value: 3 }];
  const executed = await executeExpenseSql(
    "SELECT account_id FROM accounts; SELECT rate FROM fx_rates_daily",
    createCursorExecutor({
      api_sql_read_cursor_1: firstRows,
      api_sql_read_cursor_2: secondRows,
    }, requests),
  );

  assert.deepEqual(
    requests.filter((request) => request.sql.startsWith("FETCH ")).map((request) => request.sql),
    [
      `FETCH FORWARD ${String(MAX_SQL_RETURNED_ROWS + 1)} FROM api_sql_read_cursor_1`,
      "FETCH FORWARD 1 FROM api_sql_read_cursor_2",
    ],
  );
  assert.deepEqual(executed.statements.map((statement) => statement.returnedRowCount), [100, 0]);
  assert.deepEqual(executed.statements.map((statement) => statement.totalRowCount), [100, 3]);
  assert.deepEqual(executed.statements.map((statement) => statement.truncated), [false, true]);
});

test("executeExpenseSql builds bounded requests for supported SELECT and VALUES CTEs", async (): Promise<void> => {
  const acceptedSql: ReadonlyArray<string> = [
    "WITH account_rows AS (SELECT account_id FROM accounts) SELECT account_id FROM account_rows",
    "WITH rows(value) AS (VALUES (1), (2)) SELECT value FROM rows;",
  ];

  for (const sql of acceptedSql) {
    const requests: Array<RestrictedSqlExecutionRequest> = [];
    const executed = await executeExpenseSql(sql, createCursorExecutor({
      api_sql_read_cursor_1: [{ value: 1 }],
    }, requests));

    assert.equal(
      requests[0]?.sql,
      `DECLARE api_sql_read_cursor_1 NO SCROLL CURSOR FOR ${sql.replace(/;$/u, "")}`,
    );
    assert.deepEqual(requests.map((request) => request.params), [[], [], [], []]);
    assert.equal(executed.statements[0]?.isMutating, false);
    assert.deepEqual(executed.statements[0]?.rows, [{ value: 1 }]);
  }
});

test("executeExpenseSql rejects per-statement and request-wide mutation row overflows", async (): Promise<void> => {
  await assert.rejects(
    () => executeExpenseSql(
      "UPDATE account_metadata SET liquidity = 'low'",
      async () => ({ command: "UPDATE", rows: [], rowCount: MAX_SQL_MUTATION_ROWS + 1 }),
    ),
    (error: unknown) =>
      error instanceof SqlPolicyError
      && error.code === "mutation_statement_row_limit_exceeded",
  );

  await assert.rejects(
    () => executeExpenseSql(
      "UPDATE account_metadata SET liquidity = 'low'; DELETE FROM budget_lines",
      async () => ({ command: "UPDATE", rows: [], rowCount: 60 }),
    ),
    (error: unknown) =>
      error instanceof SqlPolicyError
      && error.code === "mutation_request_row_limit_exceeded",
  );
});
