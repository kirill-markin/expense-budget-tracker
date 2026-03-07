#!/usr/bin/env bash
# Poll the deployed web app readiness endpoint until Postgres access is ready.
#
# Used after AWS deploys because /api/live only confirms the process is up.
#
# Required env vars:
#   ALB_DNS — ALB DNS name from CloudFormation outputs
#
# Optional env vars:
#   READINESS_TIMEOUT_SECONDS  — total wait time (default: 300)
#   READINESS_INTERVAL_SECONDS — delay between checks (default: 10)

set -euo pipefail

: "${ALB_DNS:?ALB_DNS env var is required}"

TIMEOUT_SECONDS="${READINESS_TIMEOUT_SECONDS:-300}"
INTERVAL_SECONDS="${READINESS_INTERVAL_SECONDS:-10}"
URL="https://${ALB_DNS}/api/health"
ELAPSED=0

echo "Waiting for web readiness at ${URL} ..."

while true; do
  if curl --fail --silent --show-error --insecure "$URL" > /dev/null; then
    echo "Web readiness check passed."
    exit 0
  fi

  if [ "$ELAPSED" -ge "$TIMEOUT_SECONDS" ]; then
    echo "ERROR: Web readiness check timed out after ${TIMEOUT_SECONDS}s: ${URL}" >&2
    exit 1
  fi

  sleep "$INTERVAL_SECONDS"
  ELAPSED=$((ELAPSED + INTERVAL_SECONDS))
done
