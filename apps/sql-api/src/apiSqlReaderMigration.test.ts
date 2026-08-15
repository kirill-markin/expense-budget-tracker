import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const readApiSqlReaderMigration = (): string =>
  readFileSync(
    fileURLToPath(new URL("../../../db/migrations/0066_api_sql_reader.sql", import.meta.url)),
    "utf8",
  );

test("API SQL reader migration uses RDS-compatible least-privilege role management", (): void => {
  const migration = readApiSqlReaderMigration();

  assert.match(migration, /CREATE ROLE api_sql_reader WITH NOLOGIN NOINHERIT;/u);
  assert.doesNotMatch(migration, /\bALTER\s+ROLE\s+(?:api_sql_reader\b|"api_sql_reader")/iu);
  assert.match(migration, /existing_role\.rolsuper/u);
  assert.match(migration, /existing_role\.rolcreatedb/u);
  assert.match(migration, /existing_role\.rolcreaterole/u);
  assert.match(migration, /existing_role\.rolinherit/u);
  assert.match(migration, /existing_role\.rolcanlogin/u);
  assert.match(migration, /existing_role\.rolreplication/u);
  assert.match(migration, /existing_role\.rolbypassrls/u);
  assert.match(migration, /FROM pg_catalog\.pg_auth_members AS membership/u);
  assert.match(migration, /WHERE membership\.member = existing_role\.oid/u);
  assert.match(migration, /RAISE EXCEPTION USING/u);
  assert.match(migration, /GRANT api_sql_reader TO app;/u);
});
