#!/bin/bash
set -euo pipefail
# DB_PASSWORD is safe for URL embedding — RDS secret excludes special characters.
export MIGRATION_DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:5432/${DB_NAME}?sslmode=require"
exec bash /scripts/migrate.sh
