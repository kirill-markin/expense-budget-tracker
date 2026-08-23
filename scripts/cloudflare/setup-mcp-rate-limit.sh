#!/usr/bin/env bash
# Reconcile the zone-level Cloudflare Free rate-limit rule for the public MCP endpoint.
# Requires CLOUDFLARE_API_TOKEN with Zone WAF Edit and CLOUDFLARE_ZONE_ID.
# Usage from the repository root; the parent shell never receives the token:
#   (
#     set -euo pipefail
#     set -a
#     source scripts/cloudflare/.env
#     set +a
#     bash scripts/cloudflare/setup-mcp-rate-limit.sh --domain expense-budget-tracker.com
#   )

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXPECTED_RULE_FILE="${SCRIPT_DIR}/mcp-rate-limit-rule.json"
source "${SCRIPT_DIR}/cloudflare-api.sh"

DOMAIN=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --domain) DOMAIN="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$DOMAIN" ]]; then
  echo "Usage: $0 --domain <domain>" >&2
  exit 1
fi

cloudflare_require_api_token
: "${CLOUDFLARE_ZONE_ID:?Set CLOUDFLARE_ZONE_ID env var}"

ZONE_RESPONSE=$(cloudflare_api_request \
  "read MCP rate-limit zone" \
  "GET" \
  "/zones/${CLOUDFLARE_ZONE_ID}" \
  "")
ZONE_NAME=$(echo "$ZONE_RESPONSE" | python3 -c '
import json
import sys

response = json.load(sys.stdin)
result = response.get("result")
name = result.get("name") if response.get("success") is True and isinstance(result, dict) else None
if not isinstance(name, str) or not name:
    print("ERROR: Cloudflare zone lookup returned no domain name.", file=sys.stderr)
    raise SystemExit(1)
print(name)
')
if [[ "$ZONE_NAME" != "$DOMAIN" ]]; then
  echo "ERROR: Cloudflare zone ${ZONE_NAME} does not match requested domain ${DOMAIN}." >&2
  exit 1
fi

build_rate_limit_ruleset_payload() {
  local expected_rule_file="$1"
  python3 -c '
import json
import pathlib
import sys

expected_rule = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
if not isinstance(expected_rule, dict):
    print("ERROR: MCP rate-limit contract must contain a JSON object.", file=sys.stderr)
    raise SystemExit(1)

response = json.load(sys.stdin)
if not isinstance(response, dict):
    print("ERROR: Cloudflare rate-limit response must contain a JSON object.", file=sys.stderr)
    raise SystemExit(1)
if response.get("success") is True:
    result = response.get("result")
    existing_rules = result.get("rules", []) if isinstance(result, dict) else []
else:
    errors = response.get("errors", [])
    not_found = any(
        "not found" in str(error.get("message", "")).lower()
        for error in errors
        if isinstance(error, dict)
    )
    if not not_found:
        print("ERROR: Could not fetch the Cloudflare rate-limit ruleset.", file=sys.stderr)
        print("ACTION: Grant the token Zone WAF Edit for the requested zone.", file=sys.stderr)
        print(json.dumps(errors if errors else response, indent=2), file=sys.stderr)
        raise SystemExit(1)
    existing_rules = []

if not isinstance(existing_rules, list) or any(not isinstance(rule, dict) for rule in existing_rules):
    print("ERROR: Cloudflare returned an invalid rate-limit rules array.", file=sys.stderr)
    raise SystemExit(1)

description = expected_rule.get("description")
expression = expected_rule.get("expression")
if not isinstance(description, str) or not description:
    print("ERROR: MCP rate-limit contract has no description.", file=sys.stderr)
    raise SystemExit(1)
if not isinstance(expression, str) or not expression:
    print("ERROR: MCP rate-limit contract has no expression.", file=sys.stderr)
    raise SystemExit(1)
managed_rules = [
    rule
    for rule in existing_rules
    if rule.get("description") == description or rule.get("expression") == expression
]
unmanaged_rules = [
    rule
    for rule in existing_rules
    if rule.get("description") != description and rule.get("expression") != expression
]
if unmanaged_rules and not managed_rules:
    descriptions = [str(rule.get("description") or "<unnamed>") for rule in unmanaged_rules]
    print(
        "ERROR: The Cloudflare Free plan has an existing unrelated rate-limit rule: "
        + ", ".join(descriptions),
        file=sys.stderr,
    )
    print("ACTION: Decide which single Free-plan rate-limit rule should own the zone before rerunning.", file=sys.stderr)
    raise SystemExit(1)

read_only_rule_fields = {"id", "version", "last_updated"}
preserved_rules = [
    {
        key: value
        for key, value in rule.items()
        if key not in read_only_rule_fields
    }
    for rule in unmanaged_rules
]
print(json.dumps({"rules": [*preserved_rules, expected_rule]}))
' "$expected_rule_file"
}

RATE_LIMIT_RULESET=$(cloudflare_optional_get_request \
  "read MCP rate-limit ruleset" \
  "/zones/${CLOUDFLARE_ZONE_ID}/rulesets/phases/http_ratelimit/entrypoint")
RATE_LIMIT_PAYLOAD=$(echo "$RATE_LIMIT_RULESET" | build_rate_limit_ruleset_payload "$EXPECTED_RULE_FILE")
RATE_LIMIT_RESULT=$(cloudflare_api_request \
  "replace MCP rate-limit ruleset" \
  "PUT" \
  "/zones/${CLOUDFLARE_ZONE_ID}/rulesets/phases/http_ratelimit/entrypoint" \
  "$RATE_LIMIT_PAYLOAD")

echo "$RATE_LIMIT_RESULT" | python3 "${SCRIPT_DIR}/assert-mcp-rate-limit.py" "$EXPECTED_RULE_FILE"
