#!/usr/bin/env bash
# Poll the deployed web app readiness endpoint until Postgres access is ready.
#
# Used after AWS deploys because /api/live only confirms the process is up.
#
# Prefer the public app URL, which reaches the origin through Cloudflare and so
# carries the origin shared secret the WAF may require. Only the first-deploy
# bootstrap, which runs before Cloudflare DNS exists, probes the ALB directly.
#
# Required env vars:
#   READINESS_URL — full readiness URL to poll, e.g. https://app.example.com/api/health
#
# Optional env vars:
#   READINESS_INSECURE         — "true" skips TLS verification (raw ALB origin cert)
#   READINESS_TIMEOUT_SECONDS  — total wait time (default: 300)
#   READINESS_INTERVAL_SECONDS — delay between checks (default: 10)

set -euo pipefail

: "${READINESS_URL:?READINESS_URL env var is required}"

TIMEOUT_SECONDS="${READINESS_TIMEOUT_SECONDS:-300}"
INTERVAL_SECONDS="${READINESS_INTERVAL_SECONDS:-10}"
URL="$READINESS_URL"
ELAPSED=0

CURL_ARGS=(--fail --silent --show-error)
if [ "${READINESS_INSECURE:-false}" = "true" ]; then
  CURL_ARGS+=(--insecure)
fi

echo "Waiting for web readiness at ${URL} ..."

while true; do
  if curl "${CURL_ARGS[@]}" "$URL" > /dev/null; then
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
