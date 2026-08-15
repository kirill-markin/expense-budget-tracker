#!/usr/bin/env bash
# Verify that all expected Cloudflare DNS records and SSL settings exist.
# Drift detection for Cloudflare resources that live outside IaC.
#
# Required env vars:
#   CLOUDFLARE_API_TOKEN  — API token with Zone, DNS, SSL, and Cache Rules read access
#   CLOUDFLARE_ZONE_ID    — Zone ID from Cloudflare dashboard
#   AWS_PROFILE           — explicit AWS CLI profile for the deployment account
#   AWS_REGION            — explicit AWS region for the deployed stack
#
# Usage from the repository root; the parent shell never receives the token:
#   (
#     set -euo pipefail
#     set -a
#     source scripts/cloudflare/.env
#     set +a
#     export AWS_PROFILE=expense-tracker AWS_REGION=eu-central-1
#     bash scripts/cloudflare/verify.sh --stack-name ExpenseBudgetTracker
#   )

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CDK_CONTEXT_FILE="${ROOT_DIR}/infra/aws/cdk.context.local.json"
source "${SCRIPT_DIR}/cloudflare-api.sh"
source "${SCRIPT_DIR}/aws-api.sh"

STACK_NAME="ExpenseBudgetTracker"
AWS_PROFILE="${AWS_PROFILE:-}"
AWS_REGION="${AWS_REGION:-}"
while [[ $# -gt 0 ]]; do
  case $1 in
    --stack-name) STACK_NAME="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

cloudflare_require_api_token
: "${CLOUDFLARE_ZONE_ID:?Set CLOUDFLARE_ZONE_ID env var}"

ERRORS=0
STACK_ALB_DNS=""
STACK_API_TARGET=""
STACK_MCP_TARGET=""
STACK_MCP_URL=""

if [[ -z "$AWS_PROFILE" ]]; then
  echo "ERROR: AWS_PROFILE is required and must identify the dedicated deployment account." >&2
  exit 1
fi
if [[ -z "$AWS_REGION" ]]; then
  echo "ERROR: AWS_REGION is required and must identify the explicit deployment region." >&2
  exit 1
fi
if [[ ! -f "$CDK_CONTEXT_FILE" ]]; then
  echo "ERROR: ${CDK_CONTEXT_FILE} is required for verification." >&2
  exit 1
fi

DEPLOYMENT_CONTEXT=$(python3 - "$CDK_CONTEXT_FILE" <<'PY'
import json
import pathlib
import re
import sys

context_path = pathlib.Path(sys.argv[1])
context = json.loads(context_path.read_text(encoding="utf-8"))
if not isinstance(context, dict):
    print(f"ERROR: {context_path} must contain a JSON object.", file=sys.stderr)
    raise SystemExit(1)

required_strings = [
    "region",
    "domainName",
    "certificateArn",
    "apiCertificateArn",
    "mcpCertificateArn",
    "resendApiKeySecretArn",
]
missing = [
    key for key in required_strings
    if not isinstance(context.get(key), str) or not context[key].strip()
]
if missing:
    print(
        f"ERROR: {context_path} must define non-empty deployed values for: {', '.join(missing)}.",
        file=sys.stderr,
    )
    raise SystemExit(1)

region = context["region"]
account_ids = set()
for key in ["certificateArn", "apiCertificateArn", "mcpCertificateArn", "resendApiKeySecretArn"]:
    value = context[key]
    match = re.match(r"^arn:[^:]+:[^:]+:([^:]+):([0-9]{12}):", value)
    if match is None:
        print(f"ERROR: {context_path} value {key} is not a regional AWS ARN.", file=sys.stderr)
        raise SystemExit(1)
    arn_region, account_id = match.groups()
    if arn_region != region:
        print(
            f"ERROR: {context_path} value {key} targets region {arn_region}, expected {region}.",
            file=sys.stderr,
        )
        raise SystemExit(1)
    account_ids.add(account_id)

print(json.dumps({
    "accountIds": sorted(account_ids),
    "domainName": context.get("domainName"),
    "region": region,
}))
PY
)
CONTEXT_REGION=$(echo "$DEPLOYMENT_CONTEXT" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("region") or "")')
CONTEXT_DOMAIN=$(echo "$DEPLOYMENT_CONTEXT" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("domainName") or "")')
CONTEXT_ACCOUNT_COUNT=$(echo "$DEPLOYMENT_CONTEXT" | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("accountIds", [])))')
if [[ "$CONTEXT_REGION" != "$AWS_REGION" ]]; then
  echo "ERROR: AWS region ${AWS_REGION} does not match ${CDK_CONTEXT_FILE} region ${CONTEXT_REGION}." >&2
  exit 1
fi
if [[ "$CONTEXT_ACCOUNT_COUNT" -ne 1 ]]; then
  echo "ERROR: ${CDK_CONTEXT_FILE} must contain deployment ARNs from exactly one AWS account; found ${CONTEXT_ACCOUNT_COUNT}." >&2
  exit 1
fi
CONTEXT_ACCOUNT_ID=$(echo "$DEPLOYMENT_CONTEXT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["accountIds"][0])')

if ! AWS_IDENTITY=$(aws_api_request \
  "caller identity lookup" \
  "$AWS_PROFILE" \
  "$AWS_REGION" \
  aws sts get-caller-identity \
  --output json); then
  echo "ERROR: Failed to verify AWS caller identity with profile ${AWS_PROFILE} in region ${AWS_REGION}." >&2
  exit 1
fi
AWS_ACCOUNT_ID=$(echo "$AWS_IDENTITY" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("Account", ""))')
AWS_CALLER_ARN=$(echo "$AWS_IDENTITY" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("Arn", ""))')
if [[ ! "$AWS_ACCOUNT_ID" =~ ^[0-9]{12}$ || -z "$AWS_CALLER_ARN" ]]; then
  echo "ERROR: AWS STS returned an invalid caller identity for profile ${AWS_PROFILE}." >&2
  exit 1
fi
if [[ "$AWS_ACCOUNT_ID" != "$CONTEXT_ACCOUNT_ID" ]]; then
  echo "ERROR: AWS profile ${AWS_PROFILE} resolves to account ${AWS_ACCOUNT_ID}, but ${CDK_CONTEXT_FILE} targets account ${CONTEXT_ACCOUNT_ID}." >&2
  exit 1
fi

if ! STACK_JSON=$(aws_api_request \
  "read CloudFormation stack ${STACK_NAME}" \
  "$AWS_PROFILE" \
  "$AWS_REGION" \
  aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --output json); then
  echo "ERROR: Could not read CloudFormation stack ${STACK_NAME} in account ${AWS_ACCOUNT_ID}, region ${AWS_REGION}." >&2
  exit 1
fi
read_stack_output() {
  local output_key="$1"
  echo "$STACK_JSON" | python3 -c '
import json
import sys

output_key = sys.argv[1]
stacks = json.load(sys.stdin).get("Stacks", [])
if len(stacks) != 1:
    print(f"ERROR: Expected one CloudFormation stack, found {len(stacks)}.", file=sys.stderr)
    raise SystemExit(1)
outputs = stacks[0].get("Outputs", [])
values = [output.get("OutputValue") for output in outputs if output.get("OutputKey") == output_key]
if len(values) > 1:
    print(f"ERROR: CloudFormation output {output_key} is duplicated.", file=sys.stderr)
    raise SystemExit(1)
print(values[0] if values else "")
' "$output_key"
}
STACK_ALB_DNS=$(read_stack_output "AlbDns")
STACK_API_TARGET=$(read_stack_output "ApiCustomDomain")
STACK_MCP_TARGET=$(read_stack_output "McpCustomDomain")
STACK_MCP_URL=$(read_stack_output "McpUrl")
if [[ -z "$STACK_ALB_DNS" || "$STACK_ALB_DNS" == "None" ]]; then
  echo "ERROR: Could not read AlbDns from stack ${STACK_NAME}." >&2
  exit 1
fi
if [[ -z "$STACK_API_TARGET" || "$STACK_API_TARGET" == "None" ]]; then
  echo "ERROR: Could not read ApiCustomDomain from stack ${STACK_NAME}." >&2
  exit 1
fi
if [[ -z "$STACK_MCP_TARGET" || "$STACK_MCP_TARGET" == "None" ]]; then
  echo "ERROR: Could not read McpCustomDomain from stack ${STACK_NAME}." >&2
  exit 1
fi
EXPECTED_MCP_URL="https://mcp.${CONTEXT_DOMAIN}/mcp"
if [[ "$STACK_MCP_URL" != "$EXPECTED_MCP_URL" ]]; then
  echo "ERROR: Stack ${STACK_NAME} advertises MCP URL '${STACK_MCP_URL}', expected '${EXPECTED_MCP_URL}' from ${CDK_CONTEXT_FILE}." >&2
  echo "Redeploy the stack with the matching domain context before verifying Cloudflare." >&2
  exit 1
fi
echo "Verified AWS caller ${AWS_CALLER_ARN} in account ${AWS_ACCOUNT_ID}, region ${AWS_REGION}."

cf_api() {
  local resource_path="$1"
  cloudflare_api_request \
    "read ${resource_path:-zone metadata}" \
    "GET" \
    "/zones/${CLOUDFLARE_ZONE_ID}/${resource_path}" \
    ""
}

check_managed_cname() {
  local name="$1" label="$2" expected_target="$3"
  local result
  result=$(cf_api "dns_records?name=${name}")
  local count
  count=$(echo "$result" | python3 -c 'import sys,json; print(len(json.load(sys.stdin).get("result", [])))')
  if [[ "$count" -ne 1 ]]; then
    echo "FAIL: ${label} — expected exactly one DNS record for ${name}; found ${count}" >&2
    ERRORS=$((ERRORS + 1))
    return
  fi

  local actual_type content normalized_content normalized_expected_target proxied
  actual_type=$(echo "$result" | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"][0].get("type", ""))')
  content=$(echo "$result" | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"][0].get("content", ""))')
  normalized_content=$(printf '%s' "${content%.}" | LC_ALL=C tr '[:upper:]' '[:lower:]')
  normalized_expected_target=$(printf '%s' "${expected_target%.}" | LC_ALL=C tr '[:upper:]' '[:lower:]')
  proxied=$(echo "$result" | python3 -c 'import sys,json; print(str(json.load(sys.stdin)["result"][0].get("proxied") is True).lower())')
  if [[ "$actual_type" != "CNAME" ]]; then
    echo "FAIL: ${label} — ${name} is ${actual_type:-an unknown type}, expected CNAME" >&2
    ERRORS=$((ERRORS + 1))
  elif [[ "$normalized_content" != "$normalized_expected_target" ]]; then
    echo "FAIL: ${label} — ${name} points to '${content}', expected '${expected_target}' from stack ${STACK_NAME}" >&2
    ERRORS=$((ERRORS + 1))
  elif [[ "$proxied" != "true" ]]; then
    echo "FAIL: ${label} — ${name} matches '${expected_target}' but proxied is not true" >&2
    ERRORS=$((ERRORS + 1))
  else
    echo "  OK: ${label} — single proxied CNAME ${name} -> ${content}"
  fi
}

# --- Zone info ---
ZONE_RESPONSE=$(cf_api "")
ZONE_NAME=$(echo "$ZONE_RESPONSE" | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["name"])')
if [[ "$ZONE_NAME" != "$CONTEXT_DOMAIN" ]]; then
  echo "ERROR: Cloudflare zone ${ZONE_NAME} does not match ${CDK_CONTEXT_FILE} domainName ${CONTEXT_DOMAIN}." >&2
  exit 1
fi
echo "Zone: ${ZONE_NAME}"
echo ""

# --- DNS records ---
echo "Checking DNS records..."
check_managed_cname "app.${ZONE_NAME}" "App subdomain" "$STACK_ALB_DNS"
check_managed_cname "auth.${ZONE_NAME}" "Auth subdomain" "$STACK_ALB_DNS"
check_managed_cname "api.${ZONE_NAME}" "Machine API subdomain" "$STACK_API_TARGET"
check_managed_cname "mcp.${ZONE_NAME}" "MCP subdomain" "$STACK_MCP_TARGET"

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
CACHE_RULESET=$(cloudflare_optional_get_request \
  "read cache ruleset" \
  "/zones/${CLOUDFLARE_ZONE_ID}/rulesets/phases/http_request_cache_settings/entrypoint")
EXPECTED_CACHE_EXPRESSION="(http.host eq \"app.${ZONE_NAME}\" or http.host eq \"auth.${ZONE_NAME}\" or http.host eq \"mcp.${ZONE_NAME}\" or http.host eq \"${ZONE_NAME}\")"
CACHE_RULE_COUNT=$(echo "$CACHE_RULESET" | python3 -c '
import sys, json

def normalize_expression(expression):
    return " ".join(str(expression).split())

expected_expression = normalize_expression(sys.argv[1])
rules = json.load(sys.stdin).get("result", {}).get("rules", [])
bypass = [
    rule for rule in rules
    if rule.get("enabled") is True
    and rule.get("action") == "set_cache_settings"
    and rule.get("action_parameters", {}).get("cache") is False
    and normalize_expression(rule.get("expression", "")) == expected_expression
]
print(len(bypass))
' "$EXPECTED_CACHE_EXPRESSION")
if [[ "$CACHE_RULE_COUNT" -eq 0 ]]; then
  echo "FAIL: No enabled cache-bypass rule has the exact expected host predicate and cache=false action" >&2
  echo "  Expected: ${EXPECTED_CACHE_EXPRESSION}" >&2
  ERRORS=$((ERRORS + 1))
else
  echo "  OK: Cache bypass rule active (${CACHE_RULE_COUNT} rule(s))"
fi

# --- Summary ---
echo ""
if [[ "$ERRORS" -gt 0 ]]; then
  echo "Verification FAILED: ${ERRORS} issue(s) found." >&2
  echo "Run the setup scripts to fix (see infra/aws/README.md)." >&2
  exit 1
fi

echo "All checks passed."
