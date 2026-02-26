#!/usr/bin/env bash
# Invoke the FX fetcher Lambda and check for errors.
#
# Required env vars:
#   FX_FUNCTION — Lambda function name
#
# Optional env vars:
#   AWS_REGION — AWS region (passed as --region if set)

set -euo pipefail

: "${FX_FUNCTION:?FX_FUNCTION env var is required}"

REGION_FLAG=()
if [[ -n "${AWS_REGION:-}" ]]; then
  REGION_FLAG=(--region "$AWS_REGION")
fi

RESPONSE=$(mktemp)
aws lambda invoke \
  "${REGION_FLAG[@]}" \
  --function-name "$FX_FUNCTION" \
  --cli-read-timeout 300 \
  --output json \
  "$RESPONSE" > /tmp/invoke-meta.json

if grep -q '"FunctionError"' /tmp/invoke-meta.json; then
  echo "ERROR: FX fetcher Lambda failed:" >&2
  cat "$RESPONSE" >&2
  exit 1
fi

echo "Exchange rates seeded."
