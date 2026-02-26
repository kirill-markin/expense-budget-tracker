#!/usr/bin/env bash
# Verify that all expected Cloudflare DNS records and SSL settings exist.
# Drift detection for Cloudflare resources that live outside IaC.
#
# Required env vars:
#   CLOUDFLARE_API_TOKEN  — API token with Zone:Read, DNS:Read, SSL:Read
#   CLOUDFLARE_ZONE_ID    — Zone ID from Cloudflare dashboard
#
# Optional env vars:
#   AWS_PROFILE           — AWS CLI profile (needed for --check-stack)
#
# Usage:
#   export CLOUDFLARE_API_TOKEN="..." CLOUDFLARE_ZONE_ID="..."
#   bash scripts/cloudflare/verify.sh [--check-stack ExpenseBudgetTracker]

set -euo pipefail

STACK_NAME=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --check-stack) STACK_NAME="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

: "${CLOUDFLARE_API_TOKEN:?Set CLOUDFLARE_API_TOKEN env var}"
: "${CLOUDFLARE_ZONE_ID:?Set CLOUDFLARE_ZONE_ID env var}"

ERRORS=0

cf_api() {
  curl -sf "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/$1" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "Content-Type: application/json"
}

check_dns() {
  local name="$1" type="$2" label="$3"
  local result
  result=$(cf_api "dns_records?name=${name}&type=${type}")
  local count
  count=$(echo "$result" | python3 -c 'import sys,json; print(len(json.load(sys.stdin).get("result", [])))')
  if [[ "$count" -eq 0 ]]; then
    echo "FAIL: ${label} — no ${type} record for ${name}" >&2
    ERRORS=$((ERRORS + 1))
  else
    local content
    content=$(echo "$result" | python3 -c 'import sys,json; r=json.load(sys.stdin)["result"][0]; print(r["content"])')
    echo "  OK: ${label} — ${type} ${name} -> ${content}"
  fi
}

# --- Zone info ---
ZONE_RESPONSE=$(cf_api "")
ZONE_NAME=$(echo "$ZONE_RESPONSE" | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["name"])')
echo "Zone: ${ZONE_NAME}"
echo ""

# --- DNS records ---
echo "Checking DNS records..."
check_dns "app.${ZONE_NAME}" "CNAME" "App subdomain"
check_dns "auth.${ZONE_NAME}" "CNAME" "Auth subdomain (Cognito)"

# Root domain — could be A or CNAME (CNAME flattening)
ROOT_RECORDS=$(cf_api "dns_records?name=${ZONE_NAME}")
ROOT_COUNT=$(echo "$ROOT_RECORDS" | python3 -c '
import sys, json
records = json.load(sys.stdin).get("result", [])
root = [r for r in records if r["type"] in ("A", "AAAA", "CNAME")]
print(len(root))
')
if [[ "$ROOT_COUNT" -eq 0 ]]; then
  echo "FAIL: Root domain — no A/AAAA/CNAME record for ${ZONE_NAME}" >&2
  ERRORS=$((ERRORS + 1))
else
  echo "  OK: Root domain — ${ROOT_COUNT} record(s) found"
fi

# --- SSL/TLS mode ---
echo ""
echo "Checking SSL/TLS settings..."
SSL_RESULT=$(cf_api "settings/ssl")
SSL_VALUE=$(echo "$SSL_RESULT" | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["value"])')
if [[ "$SSL_VALUE" != "strict" ]]; then
  echo "FAIL: SSL/TLS mode is '${SSL_VALUE}', expected 'strict'" >&2
  ERRORS=$((ERRORS + 1))
else
  echo "  OK: SSL/TLS mode is Full (Strict)"
fi

# --- Cache bypass rule ---
echo ""
echo "Checking cache bypass rule..."
CACHE_RULESET=$(cf_api "rulesets/phases/http_request_cache_settings/entrypoint" 2>/dev/null || echo '{"result":{"rules":[]}}')
CACHE_RULE_COUNT=$(echo "$CACHE_RULESET" | python3 -c '
import sys, json
rules = json.load(sys.stdin).get("result", {}).get("rules", [])
bypass = [r for r in rules if r.get("action_parameters", {}).get("cache") == False]
print(len(bypass))
')
if [[ "$CACHE_RULE_COUNT" -eq 0 ]]; then
  echo "FAIL: No cache bypass rule found — Cloudflare may cache ALB auth redirects" >&2
  ERRORS=$((ERRORS + 1))
else
  echo "  OK: Cache bypass rule active (${CACHE_RULE_COUNT} rule(s))"
fi

# --- Cross-check with CloudFormation stack (optional) ---
if [[ -n "$STACK_NAME" ]]; then
  echo ""
  echo "Cross-checking with CloudFormation stack '${STACK_NAME}'..."

  ALB_DNS=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='AlbDns'].OutputValue" \
    --output text 2>/dev/null || echo "")

  if [[ -z "$ALB_DNS" || "$ALB_DNS" == "None" ]]; then
    echo "FAIL: Could not read AlbDns from stack ${STACK_NAME}" >&2
    ERRORS=$((ERRORS + 1))
  else
    APP_CNAME=$(cf_api "dns_records?name=app.${ZONE_NAME}&type=CNAME")
    APP_CONTENT=$(echo "$APP_CNAME" | python3 -c 'import sys,json; r=json.load(sys.stdin)["result"]; print(r[0]["content"] if r else "")' 2>/dev/null || echo "")
    if [[ "$APP_CONTENT" != "$ALB_DNS" ]]; then
      echo "FAIL: app.${ZONE_NAME} CNAME points to '${APP_CONTENT}', expected ALB '${ALB_DNS}'" >&2
      ERRORS=$((ERRORS + 1))
    else
      echo "  OK: app CNAME matches ALB DNS"
    fi
  fi
fi

# --- Summary ---
echo ""
if [[ "$ERRORS" -gt 0 ]]; then
  echo "Verification FAILED: ${ERRORS} issue(s) found." >&2
  echo "Run the setup scripts to fix (see infra/aws/README.md)." >&2
  exit 1
fi

echo "All checks passed."
