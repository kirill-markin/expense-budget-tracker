#!/usr/bin/env bash
# Configure Cloudflare DNS and cache bypass for the deployed stack.
# Run after the first CDK deploy and rerun to reconcile drift.
#
# Required env vars:
#   CLOUDFLARE_API_TOKEN  — API token with DNS, SSL, Zone Settings, and Cache Rules edit permissions
#   CLOUDFLARE_ZONE_ID    — Zone ID from Cloudflare dashboard
#   AWS_PROFILE           — AWS CLI profile for the target account
#   AWS_REGION            — AWS region for the deployed stack, or pass --region
#
# Usage from the repository root; the parent shell never receives the token:
#   (
#     set -euo pipefail
#     set -a
#     source scripts/cloudflare/.env
#     set +a
#     export AWS_PROFILE=expense-tracker AWS_REGION=eu-central-1
#     bash scripts/cloudflare/setup-dns.sh --stack-name ExpenseBudgetTracker --region eu-central-1
#   )

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CDK_CONTEXT_FILE="${ROOT_DIR}/infra/aws/cdk.context.local.json"
source "${SCRIPT_DIR}/cloudflare-api.sh"
source "${SCRIPT_DIR}/aws-api.sh"

# --- Parse arguments ---
SUBDOMAIN="app"
STACK_NAME="ExpenseBudgetTracker"
AWS_PROFILE="${AWS_PROFILE:-}"
AWS_REGION="${AWS_REGION:-}"
while [[ $# -gt 0 ]]; do
  case $1 in
    --stack-name) STACK_NAME="$2"; shift 2 ;;
    --region) AWS_REGION="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

cloudflare_require_api_token
: "${CLOUDFLARE_ZONE_ID:?Set CLOUDFLARE_ZONE_ID env var}"
if [[ -z "$AWS_REGION" ]]; then
  echo "ERROR: AWS region is required. Pass --region or set AWS_REGION." >&2
  exit 1
fi
if [[ -z "$AWS_PROFILE" ]]; then
  echo "ERROR: AWS_PROFILE is required and must identify the dedicated deployment account." >&2
  exit 1
fi
if [[ ! -f "$CDK_CONTEXT_FILE" ]]; then
  echo "ERROR: ${CDK_CONTEXT_FILE} is required before configuring deployed DNS." >&2
  echo "Create the deployment context as described in infra/aws/README.md step 5, then rerun." >&2
  exit 1
fi

assert_cloudflare_success() {
  python3 -c '
import json
import sys

response = json.load(sys.stdin)
if response.get("success") is True:
    print("OK")
    raise SystemExit(0)

print(json.dumps(response.get("errors", response), indent=2), file=sys.stderr)
raise SystemExit(1)
'
}

assert_required_cloudflare_success() {
  local failure_message="$1"
  local remediation="$2"

  python3 -c '
import json
import sys

failure_message = sys.argv[1]
remediation = sys.argv[2]
response = json.load(sys.stdin)
if response.get("success") is True:
    print("OK")
    raise SystemExit(0)

print(f"ERROR: {failure_message}", file=sys.stderr)
print(f"ACTION: {remediation}", file=sys.stderr)
print("Cloudflare API response:", file=sys.stderr)
print(json.dumps(response.get("errors", response), indent=2), file=sys.stderr)
raise SystemExit(1)
' "$failure_message" "$remediation"
}

build_proxied_cname_payload() {
  local name="$1"
  local content="$2"
  python3 -c '
import json
import sys

print(json.dumps({
    "type": "CNAME",
    "name": sys.argv[1],
    "content": sys.argv[2],
    "ttl": 1,
    "proxied": True,
}))
' "$name" "$content"
}

reconcile_proxied_cname_from_records() {
  local label="$1"
  local hostname="$2"
  local target="$3"
  local existing="$4"
  local creation_reconciliation_path="$5"
  local record
  local state
  local record_id
  local payload

  record=$(echo "$existing" | cloudflare_classify_exact_cname \
    "$hostname" \
    "$target" \
    "true" \
    "setup-dns.sh")
  state=$(echo "$record" | python3 -c 'import json,sys; print(json.load(sys.stdin)["state"])')
  record_id=$(echo "$record" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
  payload=$(build_proxied_cname_payload "$hostname" "$target")

  if [[ "$state" == "exact" ]]; then
    echo "${label} CNAME already matches ${target} and is proxied; reusing it."
  elif [[ "$state" == "drift" ]]; then
    local current_content
    local current_proxied
    current_content=$(echo "$record" | python3 -c 'import json,sys; print(json.load(sys.stdin)["content"])')
    current_proxied=$(echo "$record" | python3 -c 'import json,sys; print(str(json.load(sys.stdin)["proxied"]).lower())')
    echo "Reconciling singleton ${label} CNAME drift: current target=${current_content}, proxied=${current_proxied}; expected target=${target}, proxied=true."
    cloudflare_api_request \
      "update ${label} CNAME ${hostname}" \
      "PUT" \
      "/zones/${CLOUDFLARE_ZONE_ID}/dns_records/${record_id}" \
      "$payload" | assert_cloudflare_success
  elif [[ "$state" == "absent" ]]; then
    cloudflare_api_request \
      "create ${label} CNAME ${hostname}" \
      "POST" \
      "/zones/${CLOUDFLARE_ZONE_ID}/dns_records" \
      "$payload" \
      "$creation_reconciliation_path" | assert_cloudflare_success
  else
    echo "ERROR: Unexpected DNS reconciliation state '${state}' for ${label} hostname ${hostname}." >&2
    return 1
  fi
}

reconcile_proxied_cname() {
  local label="$1"
  local hostname="$2"
  local target="$3"
  local existing

  existing=$(cloudflare_read_all_dns_records \
    "read all DNS records for ${label} ${hostname}" \
    "/zones/${CLOUDFLARE_ZONE_ID}/dns_records?name=${hostname}&per_page=100")
  reconcile_proxied_cname_from_records \
    "$label" \
    "$hostname" \
    "$target" \
    "$existing" \
    "/zones/${CLOUDFLARE_ZONE_ID}/dns_records?name=${hostname}&per_page=100"
}

build_cache_ruleset_payload() {
  local rule_description="$1"
  local rule_expression="$2"

  python3 -c '
import json
import sys

rule_description = sys.argv[1]
rule_expression = sys.argv[2]
response = json.load(sys.stdin)

if response.get("success") is True:
    result = response.get("result")
    if isinstance(result, dict):
        existing_rules = result.get("rules", [])
    else:
        existing_rules = []
else:
    errors = response.get("errors", [])
    not_found = any("not found" in str(error.get("message", "")).lower() for error in errors)
    if not not_found:
        print("ERROR: Could not fetch existing Cloudflare cache ruleset.", file=sys.stderr)
        print("ACTION: Check CLOUDFLARE_ZONE_ID and token permissions for Zone:Cache Rules:Edit.", file=sys.stderr)
        print("Cloudflare API response:", file=sys.stderr)
        print(json.dumps(errors if errors else response, indent=2), file=sys.stderr)
        raise SystemExit(1)
    existing_rules = []

cache_rule = {
    "expression": rule_expression,
    "description": rule_description,
    "action": "set_cache_settings",
    "enabled": True,
    "action_parameters": {
        "cache": False,
    },
}

read_only_rule_fields = {"id", "version", "last_updated"}
merged_rules = []
rule_replaced = False

for existing_rule in existing_rules:
    if (
        existing_rule.get("description") == rule_description
        or existing_rule.get("expression") == rule_expression
    ):
        if not rule_replaced:
            merged_rules.append(cache_rule)
            rule_replaced = True
        continue

    merged_rules.append({
        key: value
        for key, value in existing_rule.items()
        if key not in read_only_rule_fields
    })

if not rule_replaced:
    merged_rules.append(cache_rule)

print(json.dumps({"rules": merged_rules}))
' "$rule_description" "$rule_expression"
}

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

account_ids = set()
for value in context.values():
    if not isinstance(value, str):
        continue
    match = re.match(r"^arn:[^:]+:[^:]*:[^:]*:([0-9]{12}):", value)
    if match:
        account_ids.add(match.group(1))

print(json.dumps({
    "accountIds": sorted(account_ids),
    "domainName": context.get("domainName"),
    "region": context.get("region"),
}))
PY
)
CONTEXT_REGION=$(echo "$DEPLOYMENT_CONTEXT" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("region") or "")')
CONTEXT_DOMAIN=$(echo "$DEPLOYMENT_CONTEXT" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("domainName") or "")')
CONTEXT_ACCOUNT_COUNT=$(echo "$DEPLOYMENT_CONTEXT" | python3 -c 'import json,sys; print(len(json.load(sys.stdin).get("accountIds", [])))')
if [[ -z "$CONTEXT_REGION" || -z "$CONTEXT_DOMAIN" ]]; then
  echo "ERROR: ${CDK_CONTEXT_FILE} must define non-empty region and domainName values." >&2
  exit 1
fi
if [[ "$CONTEXT_REGION" != "$AWS_REGION" ]]; then
  echo "ERROR: AWS region ${AWS_REGION} does not match ${CDK_CONTEXT_FILE} region ${CONTEXT_REGION}." >&2
  exit 1
fi
if [[ "$CONTEXT_ACCOUNT_COUNT" -ne 1 ]]; then
  echo "ERROR: ${CDK_CONTEXT_FILE} must contain ARNs from exactly one AWS account; found ${CONTEXT_ACCOUNT_COUNT}." >&2
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
echo "Verified AWS caller ${AWS_CALLER_ARN} in account ${AWS_ACCOUNT_ID}, region ${AWS_REGION}."

echo "Reading deployment targets from CloudFormation stack '${STACK_NAME}'..."
if ! STACK_JSON=$(aws_api_request \
  "read CloudFormation stack ${STACK_NAME}" \
  "$AWS_PROFILE" \
  "$AWS_REGION" \
  aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --output json); then
  echo "ERROR: Could not read CloudFormation stack '${STACK_NAME}' in account ${AWS_ACCOUNT_ID}, region ${AWS_REGION}." >&2
  echo "Run the first deploy first (see infra/aws/README.md step 6)." >&2
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

ALB_DNS=$(read_stack_output "AlbDns")
API_DOMAIN_TARGET=$(read_stack_output "ApiCustomDomain")
MCP_DOMAIN_TARGET=$(read_stack_output "McpCustomDomain")
MCP_URL=$(read_stack_output "McpUrl")

if [[ -z "$ALB_DNS" || "$ALB_DNS" == "None" ]]; then
  echo "ERROR: Could not find AlbDns output in stack ${STACK_NAME}." >&2
  exit 1
fi
if [[ -z "$MCP_DOMAIN_TARGET" || "$MCP_DOMAIN_TARGET" == "None" ]]; then
  echo "ERROR: Could not find the required McpCustomDomain output in stack ${STACK_NAME}." >&2
  echo "Run setup-mcp-domain.sh, set mcpCertificateArn, and redeploy before configuring DNS." >&2
  exit 1
fi
EXPECTED_MCP_URL="https://mcp.${CONTEXT_DOMAIN}/mcp"
if [[ "$MCP_URL" != "$EXPECTED_MCP_URL" ]]; then
  echo "ERROR: Stack ${STACK_NAME} advertises MCP URL '${MCP_URL}', expected '${EXPECTED_MCP_URL}' from ${CDK_CONTEXT_FILE}." >&2
  echo "Redeploy the stack with the matching domain context before configuring Cloudflare." >&2
  exit 1
fi

echo "ALB DNS: ${ALB_DNS}"

# --- Get zone name for fully qualified lookups ---
ZONE_RESPONSE=$(cloudflare_api_request \
  "read deployment zone" \
  "GET" \
  "/zones/${CLOUDFLARE_ZONE_ID}" \
  "")
ZONE_NAME=$(echo "$ZONE_RESPONSE" | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["name"])')
if [[ "$ZONE_NAME" != "$CONTEXT_DOMAIN" ]]; then
  echo "ERROR: Cloudflare zone ${ZONE_NAME} does not match ${CDK_CONTEXT_FILE} domainName ${CONTEXT_DOMAIN}." >&2
  echo "Use the Cloudflare zone and AWS deployment context for the same domain before rerunning." >&2
  exit 1
fi

APP_FQDN="${SUBDOMAIN}.${ZONE_NAME}"

reconcile_proxied_cname "app" "$APP_FQDN" "$ALB_DNS"

echo ""
echo "DNS record set: ${SUBDOMAIN} -> ${ALB_DNS} (Cloudflare proxied)"

# --- Auth subdomain CNAME (auth.* → same ALB, host-based routing) ---
AUTH_FQDN="auth.${ZONE_NAME}"
MCP_FQDN="mcp.${ZONE_NAME}"
echo ""
echo "Setting up auth subdomain CNAME: ${AUTH_FQDN} -> ${ALB_DNS}..."

reconcile_proxied_cname "auth" "$AUTH_FQDN" "$ALB_DNS"

echo "Auth DNS record set: auth -> ${ALB_DNS} (Cloudflare proxied)"

# --- Root domain → ALB redirect (domain.com → app.domain.com) ---
# By default, the ALB returns a 302 redirect to app.* for the root domain.
# If you serve your own site on the root domain, skip this section —
# just point root DNS to your site's hosting instead.
echo ""

# Keep an explicitly external root routing target, but ignore valid apex records
# that do not route web traffic when deciding whether this script owns routing.
ROOT_ANY=$(cloudflare_read_all_dns_records \
  "read root DNS records for ${ZONE_NAME}" \
  "/zones/${CLOUDFLARE_ZONE_ID}/dns_records?name=${ZONE_NAME}&per_page=100")
ROOT_ROUTING=$(echo "$ROOT_ANY" | python3 -c '
import json
import sys

response = json.load(sys.stdin)
records = response.get("result", [])
if not isinstance(records, list):
    print("ERROR: Cloudflare root DNS lookup returned no result array.", file=sys.stderr)
    raise SystemExit(1)
response["result"] = [
    record for record in records
    if isinstance(record, dict)
    and str(record.get("type", "")).upper() in {"A", "AAAA", "CNAME"}
]
print(json.dumps(response))
')
ROOT_OWNERSHIP=$(echo "$ROOT_ROUTING" | python3 -c '
import json
import sys

hostname = sys.argv[1].rstrip(".").lower()
alb_dns = sys.argv[2].rstrip(".").lower()
records = json.load(sys.stdin).get("result", [])
if not isinstance(records, list):
    print("ERROR: Cloudflare root DNS lookup returned no result array.", file=sys.stderr)
    raise SystemExit(1)
matching = [
    record for record in records
    if isinstance(record, dict)
    and str(record.get("name", "")).rstrip(".").lower() == hostname
]
if len(matching) > 1:
    print(f"ERROR: Found {len(matching)} A/AAAA/CNAME routing records at root hostname {sys.argv[1]}; expected at most one.", file=sys.stderr)
    print("ACTION: Resolve conflicting root web-routing records before rerunning setup-dns.sh.", file=sys.stderr)
    raise SystemExit(1)
if not matching:
    print("managed")
    raise SystemExit(0)
record = matching[0]
record_type = record.get("type")
content = str(record.get("content", "")).rstrip(".").lower()
if record_type == "A" and content == "192.0.2.1":
    print("ERROR: Root hostname contains the placeholder A record 192.0.2.1; remove it explicitly before rerunning setup-dns.sh.", file=sys.stderr)
    raise SystemExit(1)
if record_type == "CNAME" and (content == alb_dns or content.endswith(".elb.amazonaws.com")):
    print("managed")
else:
    print("external")
    print("{} {}".format(record_type, record.get("content", "")), file=sys.stderr)
' "$ZONE_NAME" "$ALB_DNS")

if [[ "$ROOT_OWNERSHIP" == "external" ]]; then
  echo "Root domain has one externally managed web-routing record; leaving it unchanged."
  echo "To use the ALB redirect instead, remove the external root record and rerun."
else
  echo "Setting up root domain CNAME -> ${ALB_DNS} (redirect to app.*)..."
  reconcile_proxied_cname_from_records \
    "root" \
    "$ZONE_NAME" \
    "$ALB_DNS" \
    "$ROOT_ROUTING" \
    "/zones/${CLOUDFLARE_ZONE_ID}/dns_records?type=CNAME&name=${ZONE_NAME}&per_page=100"
  echo "Root domain DNS: ${ZONE_NAME} -> ${ALB_DNS} (Cloudflare proxied, redirects to app.*)"
fi

# --- Set SSL/TLS mode to Full (Strict) ---
echo "Setting SSL/TLS mode to Full (Strict)..."

# Disable automatic SSL/TLS (switch to custom mode)
SSL_AUTOMATIC_RESULT=$(cloudflare_api_request \
  "set SSL automatic mode to custom" \
  "PATCH" \
  "/zones/${CLOUDFLARE_ZONE_ID}/settings/ssl_automatic_mode" \
  '{"value":"custom"}')

echo "$SSL_AUTOMATIC_RESULT" | assert_required_cloudflare_success \
  "Could not disable Cloudflare automatic SSL/TLS mode for zone ${CLOUDFLARE_ZONE_ID}." \
  "Check token permission Zone:Zone Settings:Edit, or manually set SSL/TLS mode to Full (Strict) in Cloudflare Dashboard > SSL/TLS > Overview."

SSL_RESULT=$(cloudflare_api_request \
  "set SSL mode to strict" \
  "PATCH" \
  "/zones/${CLOUDFLARE_ZONE_ID}/settings/ssl" \
  '{"value":"strict"}')

echo "$SSL_RESULT" | assert_required_cloudflare_success \
  "Could not set Cloudflare SSL/TLS mode to Full (Strict) for zone ${CLOUDFLARE_ZONE_ID}." \
  "Check token permission Zone:Zone Settings:Edit, or manually set Cloudflare Dashboard > SSL/TLS > Overview > Full (Strict)."

echo "SSL/TLS mode set to Full (Strict)."

# --- Bypass Cloudflare cache for app ---
# The app is fully dynamic (auth cookies, CSRF tokens, real-time data).
# Edge caching provides no benefit and can break auth flows.
echo ""
echo "Setting up cache bypass rule for app..."

CACHE_EXPRESSION="(http.host eq \"${APP_FQDN}\" or http.host eq \"${AUTH_FQDN}\" or http.host eq \"${MCP_FQDN}\" or http.host eq \"${ZONE_NAME}\")"
CACHE_RULE_DESCRIPTION="Bypass cache for app — fully dynamic content"

CACHE_RULESET=$(cloudflare_optional_get_request \
  "read cache ruleset" \
  "/zones/${CLOUDFLARE_ZONE_ID}/rulesets/phases/http_request_cache_settings/entrypoint")

CACHE_PAYLOAD=$(echo "$CACHE_RULESET" | build_cache_ruleset_payload "$CACHE_RULE_DESCRIPTION" "$CACHE_EXPRESSION")

CACHE_RESULT=$(cloudflare_api_request \
  "replace cache ruleset" \
  "PUT" \
  "/zones/${CLOUDFLARE_ZONE_ID}/rulesets/phases/http_request_cache_settings/entrypoint" \
  "$CACHE_PAYLOAD")

echo "$CACHE_RESULT" | assert_required_cloudflare_success \
  "Could not set Cloudflare cache bypass rule for ${APP_FQDN}, ${AUTH_FQDN}, ${MCP_FQDN}, and ${ZONE_NAME}." \
  "Check token permission Zone:Cache Rules:Edit, or manually add a Cache Rules bypass for expression: ${CACHE_EXPRESSION}"

echo "Cache bypass rule set for ${APP_FQDN}, ${AUTH_FQDN}, ${MCP_FQDN}, and ${ZONE_NAME}."

# --- API Gateway custom domain CNAME (optional) ---
# Created only when apiCertificateArn is set in CDK context (custom domain for machine clients).
if [[ -n "$API_DOMAIN_TARGET" && "$API_DOMAIN_TARGET" != "None" ]]; then
  API_FQDN="api.${ZONE_NAME}"
  echo ""
  echo "Setting up API Gateway CNAME: ${API_FQDN} -> ${API_DOMAIN_TARGET}..."

  reconcile_proxied_cname "API" "$API_FQDN" "$API_DOMAIN_TARGET"

  echo "API domain ready: https://${API_FQDN}/sql"
else
  echo ""
  echo "No ApiCustomDomain output found — skipping API CNAME."
  echo "  Set apiCertificateArn in cdk.context.local.json and redeploy to enable custom domain."
fi

# --- MCP HTTP API v2 custom domain CNAME (required for the canonical /mcp endpoint) ---
echo ""
echo "Setting up MCP Gateway CNAME: ${MCP_FQDN} -> ${MCP_DOMAIN_TARGET}..."
reconcile_proxied_cname "MCP" "$MCP_FQDN" "$MCP_DOMAIN_TARGET"
echo "MCP domain ready: https://${MCP_FQDN}/mcp"
