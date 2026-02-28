#!/usr/bin/env bash
# Run all Postgres migrations and views, then create the app role for RLS.
#
# Connection — one of:
#   MIGRATION_DATABASE_URL — full connection string (local Docker Compose).
#   PGHOST/PGUSER/PGPASSWORD/PGDATABASE/PGSSLMODE — native libpq vars (ECS via entrypoint).
#
# Optional env vars:
#   APP_DB_PASSWORD    — password for the app role (default: 'app').
#   WORKER_DB_PASSWORD — password for the worker role (default: 'worker').

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# run_psql: call psql with the connection string if set, otherwise rely on PG* env vars.
run_psql() {
  if [[ -n "${MIGRATION_DATABASE_URL:-}" ]]; then
    psql "$MIGRATION_DATABASE_URL" "$@"
  else
    psql "$@"
  fi
}

if [[ -z "${MIGRATION_DATABASE_URL:-}" && -z "${PGHOST:-}" ]]; then
  echo "ERROR: Set MIGRATION_DATABASE_URL or PGHOST/PGUSER/PGPASSWORD/PGDATABASE" >&2
  exit 1
fi

# In production (PGHOST mode), passwords must come from Secrets Manager.
# Locally (MIGRATION_DATABASE_URL mode), default to simple passwords for Docker Compose.
if [[ -n "${PGHOST:-}" && -z "${APP_DB_PASSWORD:-}" ]]; then
  echo "ERROR: APP_DB_PASSWORD is required in production (PGHOST mode)" >&2
  exit 1
fi
if [[ -n "${PGHOST:-}" && -z "${WORKER_DB_PASSWORD:-}" ]]; then
  echo "ERROR: WORKER_DB_PASSWORD is required in production (PGHOST mode)" >&2
  exit 1
fi
APP_DB_PASSWORD="${APP_DB_PASSWORD:-app}"
WORKER_DB_PASSWORD="${WORKER_DB_PASSWORD:-worker}"

# Create migration tracking table (idempotent).
# If this is an existing database (tables already created by prior deploys),
# seed the tracking table so migrations are not re-applied.
TRACKING_EXISTS=$(run_psql -tAc \
  "SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'schema_migrations'")

run_psql -q <<SQL
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
SQL

if [ "$TRACKING_EXISTS" != "1" ]; then
  HAS_TABLES=$(run_psql -tAc \
    "SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'workspaces'")
  if [ "$HAS_TABLES" = "1" ]; then
    echo "Bootstrap: existing database detected, seeding schema_migrations..."
    for f in "$ROOT_DIR"/db/migrations/*.sql; do
      BASENAME=$(basename "$f")
      echo "INSERT INTO schema_migrations (filename) VALUES (:'fname') ON CONFLICT DO NOTHING" \
        | run_psql -v "fname=$BASENAME"
      echo "  Recorded $BASENAME as already applied"
    done
  fi
fi

echo "Running migrations..."
for f in "$ROOT_DIR"/db/migrations/*.sql; do
  BASENAME=$(basename "$f")
  ALREADY=$(echo "SELECT 1 FROM schema_migrations WHERE filename = :'fname'" \
    | run_psql -v "fname=$BASENAME" -tA)
  if [ "$ALREADY" = "1" ]; then
    echo "  Skipping $BASENAME (already applied)"
    continue
  fi
  echo "  Applying $BASENAME"
  run_psql -v ON_ERROR_STOP=1 -f "$f"
  echo "INSERT INTO schema_migrations (filename) VALUES (:'fname')" \
    | run_psql -v "fname=$BASENAME"
done

echo "Applying views..."
for f in "$ROOT_DIR"/db/views/*.sql; do
  echo "  Applying $(basename "$f")"
  run_psql -f "$f"
done

echo "Setting app role password..."
# Role and GRANTs are created by migration 0003_app_role_grants.sql.
# Password passed via psql variable (:'app_pass') to avoid SQL injection from special characters.
run_psql -v "app_pass=$APP_DB_PASSWORD" <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app') THEN
    RAISE EXCEPTION 'Role app does not exist. Run migrations first.';
  END IF;
END
$$;

ALTER ROLE app WITH PASSWORD :'app_pass';
SQL

echo "Setting worker role password..."
# Role created by migration 0009_worker_role.sql.
run_psql -v "worker_pass=$WORKER_DB_PASSWORD" <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'worker') THEN
    RAISE EXCEPTION 'Role worker does not exist. Run migrations first.';
  END IF;
END
$$;

ALTER ROLE worker WITH PASSWORD :'worker_pass';
SQL

echo "Migrations complete."
