#!/usr/bin/env bash
# Run all Postgres migrations and views in order.
# Usage: DATABASE_URL=postgresql://... ./scripts/migrate.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL is not set" >&2
  exit 1
fi

echo "Running migrations..."
for f in "$ROOT_DIR"/db/migrations/*.sql; do
  echo "  Applying $(basename "$f")"
  psql "$DATABASE_URL" -f "$f"
done

echo "Applying views..."
for f in "$ROOT_DIR"/db/views/*.sql; do
  echo "  Applying $(basename "$f")"
  psql "$DATABASE_URL" -f "$f"
done

echo "Migrations complete."
