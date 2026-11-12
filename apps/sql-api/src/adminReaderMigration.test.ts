import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const EXPECTED_TABLES: ReadonlyArray<string> = [
  "users",
  "workspaces",
  "workspace_members",
  "chat_sessions",
  "chat_items",
  "chat_files",
  "llm_telemetry_spans",
];

const readAdminReaderMigration = (): string =>
  readFileSync(
    fileURLToPath(new URL("../../../db/migrations/0089_admin_reader_role.sql", import.meta.url)),
    "utf8",
  );

test("admin reader migration creates a least-privilege read-only login role", (): void => {
  const migration = readAdminReaderMigration();

  assert.match(
    migration,
    /CREATE ROLE admin_reader WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;/u,
  );
  assert.match(migration, /existing_role\.rolsuper/u);
  assert.match(migration, /existing_role\.rolcreatedb/u);
  assert.match(migration, /existing_role\.rolcreaterole/u);
  assert.match(migration, /existing_role\.rolinherit/u);
  assert.match(migration, /NOT existing_role\.rolcanlogin/u);
  assert.match(migration, /existing_role\.rolreplication/u);
  assert.match(migration, /existing_role\.rolbypassrls/u);
  assert.match(migration, /WHERE membership\.member = existing_role\.oid/u);
  assert.match(migration, /ALTER ROLE admin_reader SET default_transaction_read_only = on;/u);
  assert.match(migration, /ALTER ROLE admin_reader SET statement_timeout = '30s';/u);
  assert.doesNotMatch(migration, /\bBYPASSRLS\b/u);
  assert.doesNotMatch(migration, /GRANT\s+admin_reader\s+TO/iu);
});

test("admin reader migration grants SELECT with an all-rows policy on exactly the expected tables", (): void => {
  const migration = readAdminReaderMigration();

  const selectGrant = /GRANT SELECT ON TABLE\s+([^;]+?)\s+TO admin_reader;/u.exec(migration);
  assert.ok(selectGrant, "Expected one GRANT SELECT ON TABLE ... TO admin_reader statement");
  const grantedTables = selectGrant[1].split(",").map((table: string): string => table.trim().replace(/^public\./u, ""));
  assert.deepEqual(grantedTables, EXPECTED_TABLES);

  const policyTables = [...migration.matchAll(
    /CREATE POLICY (\w+)_admin_reader_select\s+ON public\.(\w+) FOR SELECT TO admin_reader USING \(true\);/gu,
  )].map((match: RegExpMatchArray): string => {
    assert.equal(match[1], match[2], `Policy name must start with its table name, found ${match[0]}`);
    return match[2];
  });
  assert.deepEqual(policyTables, EXPECTED_TABLES);
  assert.equal([...migration.matchAll(/CREATE POLICY/gu)].length, EXPECTED_TABLES.length);

  assert.doesNotMatch(migration, /GRANT\s+(?:ALL|INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER)\b/iu);
  assert.doesNotMatch(migration, /GRANT\s+EXECUTE\b/iu);
  assert.match(migration, /admin_reader invariant failed: unexpected % privilege on %/u);
});
