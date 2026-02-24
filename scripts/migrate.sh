#!/usr/bin/env bash
# Run all Postgres migrations and views, then create the app role for RLS.
#
# Required env vars:
#   MIGRATION_DATABASE_URL — owner role (tracker), used for DDL and role creation.
#
# Optional env vars:
#   APP_DB_PASSWORD — password for the app role (default: 'app').

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -z "${MIGRATION_DATABASE_URL:-}" ]; then
  echo "ERROR: MIGRATION_DATABASE_URL is not set" >&2
  exit 1
fi

APP_DB_PASSWORD="${APP_DB_PASSWORD:-app}"

# Create migration tracking table (idempotent).
# If this is an existing database (tables already created by prior deploys),
# seed the tracking table so migrations are not re-applied.
TRACKING_EXISTS=$(psql "$MIGRATION_DATABASE_URL" -tAc \
  "SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'schema_migrations'")

psql "$MIGRATION_DATABASE_URL" -q <<SQL
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
SQL

if [ "$TRACKING_EXISTS" != "1" ]; then
  HAS_TABLES=$(psql "$MIGRATION_DATABASE_URL" -tAc \
    "SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'workspaces'")
  if [ "$HAS_TABLES" = "1" ]; then
    echo "Bootstrap: existing database detected, seeding schema_migrations..."
    for f in "$ROOT_DIR"/db/migrations/*.sql; do
      BASENAME=$(basename "$f")
      echo "INSERT INTO schema_migrations (filename) VALUES (:'fname') ON CONFLICT DO NOTHING" \
        | psql "$MIGRATION_DATABASE_URL" -v "fname=$BASENAME"
      echo "  Recorded $BASENAME as already applied"
    done
  fi
fi

echo "Running migrations..."
for f in "$ROOT_DIR"/db/migrations/*.sql; do
  BASENAME=$(basename "$f")
  ALREADY=$(echo "SELECT 1 FROM schema_migrations WHERE filename = :'fname'" \
    | psql "$MIGRATION_DATABASE_URL" -v "fname=$BASENAME" -tA)
  if [ "$ALREADY" = "1" ]; then
    echo "  Skipping $BASENAME (already applied)"
    continue
  fi
  echo "  Applying $BASENAME"
  psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
  echo "INSERT INTO schema_migrations (filename) VALUES (:'fname')" \
    | psql "$MIGRATION_DATABASE_URL" -v "fname=$BASENAME"
done

echo "Applying views..."
for f in "$ROOT_DIR"/db/views/*.sql; do
  echo "  Applying $(basename "$f")"
  psql "$MIGRATION_DATABASE_URL" -f "$f"
done

echo "Creating app role..."
psql "$MIGRATION_DATABASE_URL" <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app') THEN
    CREATE ROLE app WITH LOGIN PASSWORD '${APP_DB_PASSWORD}';
  ELSE
    ALTER ROLE app WITH PASSWORD '${APP_DB_PASSWORD}';
  END IF;
END
\$\$;

GRANT CONNECT ON DATABASE tracker TO app;
GRANT USAGE ON SCHEMA public TO app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  ledger_entries, budget_lines, budget_comments, workspace_settings
TO app;
GRANT SELECT, INSERT ON TABLE workspaces, workspace_members TO app;
GRANT SELECT ON TABLE exchange_rates, accounts TO app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app;
SQL

echo "Migrations complete."
