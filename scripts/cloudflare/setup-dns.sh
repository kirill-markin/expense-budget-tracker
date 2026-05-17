#!/usr/bin/env bash
# Create a Cloudflare DNS CNAME record pointing to the ALB.
# Run once after the first CDK deploy.
#
# Required env vars:
#   CLOUDFLARE_API_TOKEN  — API token with Zone:DNS:Edit, Zone:SSL and Certificates:Edit, Zone:Zone Settings:Edit, Zone:Cache Rules:Edit
#   CLOUDFLARE_ZONE_ID    — Zone ID from Cloudflare dashboard
#   AWS_PROFILE           — AWS CLI profile for the target account
#
# Usage:
#   export CLOUDFLARE_API_TOKEN="..." CLOUDFLARE_ZONE_ID="..." AWS_PROFILE=expense-tracker
#   bash scripts/cloudflare/setup-dns.sh --stack-name ExpenseBudgetTracker --region eu-central-1

set -euo pipefail

# --- Parse arguments ---
SUBDOMAIN="app"
STACK_NAME="ExpenseBudgetTracker"
AWS_REGION="${AWS_REGION:-}"
while [[ $# -gt 0 ]]; do
  case $1 in
    --stack-name) STACK_NAME="$2"; shift 2 ;;
    --region) AWS_REGION="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

: "${CLOUDFLARE_API_TOKEN:?Set CLOUDFLARE_API_TOKEN env var}"
: "${CLOUDFLARE_ZONE_ID:?Set CLOUDFLARE_ZONE_ID env var}"
if [[ -z "$AWS_REGION" ]]; then
  echo "ERROR: AWS region is required. Pass --region or set AWS_REGION." >&2
  exit 1
fi

AWS_ARGS=(--region "$AWS_REGION")

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

# --- Verify CDK stack exists ---
if ! aws cloudformation describe-stacks --stack-name "$STACK_NAME" "${AWS_ARGS[@]}" &>/dev/null; then
  echo "ERROR: CloudFormation stack '${STACK_NAME}' not found." >&2
  echo "Run the first deploy first (see infra/aws/README.md step 6)." >&2
  exit 1
fi

# --- Get ALB DNS from CloudFormation outputs ---
echo "Reading ALB DNS from CloudFormation stack '${STACK_NAME}'..."

ALB_DNS=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  "${AWS_ARGS[@]}" \
  --query "Stacks[0].Outputs[?OutputKey=='AlbDns'].OutputValue" \
  --output text)

if [[ -z "$ALB_DNS" || "$ALB_DNS" == "None" ]]; then
  echo "Could not find AlbDns output in stack ${STACK_NAME}" >&2
  exit 1
fi

echo "ALB DNS: ${ALB_DNS}"

# --- Get zone name for fully qualified lookups ---
ZONE_NAME=$(curl -s "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["name"])')

APP_FQDN="${SUBDOMAIN}.${ZONE_NAME}"

# --- Check if record already exists ---
EXISTING=$(curl -s "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records?name=${APP_FQDN}&type=CNAME" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json")

EXISTING_COUNT=$(echo "$EXISTING" | python3 -c 'import sys,json; print(len(json.load(sys.stdin).get("result", [])))')

if [[ "$EXISTING_COUNT" -gt 0 ]]; then
  # Update existing record
  RECORD_ID=$(echo "$EXISTING" | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"][0]["id"])')
  echo "Updating existing CNAME record (${RECORD_ID})..."

  curl -s -X PUT "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records/${RECORD_ID}" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "{
      \"type\": \"CNAME\",
      \"name\": \"${SUBDOMAIN}\",
      \"content\": \"${ALB_DNS}\",
      \"ttl\": 1,
      \"proxied\": true
    }" | assert_cloudflare_success
else
  # Create new record
  echo "Creating CNAME record: ${SUBDOMAIN} -> ${ALB_DNS} (proxied)..."

  curl -s -X POST "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "{
      \"type\": \"CNAME\",
      \"name\": \"${SUBDOMAIN}\",
      \"content\": \"${ALB_DNS}\",
      \"ttl\": 1,
      \"proxied\": true
    }" | assert_cloudflare_success
fi

echo ""
echo "DNS record set: ${SUBDOMAIN} -> ${ALB_DNS} (Cloudflare proxied)"

# --- Auth subdomain CNAME (auth.* → same ALB, host-based routing) ---
AUTH_FQDN="auth.${ZONE_NAME}"
echo ""
echo "Setting up auth subdomain CNAME: ${AUTH_FQDN} -> ${ALB_DNS}..."

AUTH_EXISTING=$(curl -s "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records?name=${AUTH_FQDN}&type=CNAME" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json")

AUTH_EXISTING_COUNT=$(echo "$AUTH_EXISTING" | python3 -c 'import sys,json; print(len(json.load(sys.stdin).get("result", [])))')

if [[ "$AUTH_EXISTING_COUNT" -gt 0 ]]; then
  AUTH_RECORD_ID=$(echo "$AUTH_EXISTING" | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"][0]["id"])')
  echo "Updating existing auth CNAME record..."
  curl -s -X PUT "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records/${AUTH_RECORD_ID}" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "{
      \"type\": \"CNAME\",
      \"name\": \"auth\",
      \"content\": \"${ALB_DNS}\",
      \"ttl\": 1,
      \"proxied\": true
    }" | assert_cloudflare_success
else
  echo "Creating CNAME: auth -> ${ALB_DNS} (proxied)..."
  curl -s -X POST "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "{
      \"type\": \"CNAME\",
      \"name\": \"auth\",
      \"content\": \"${ALB_DNS}\",
      \"ttl\": 1,
      \"proxied\": true
    }" | assert_cloudflare_success
fi

echo "Auth DNS record set: auth -> ${ALB_DNS} (Cloudflare proxied)"

# --- Root domain → ALB redirect (domain.com → app.domain.com) ---
# By default, the ALB returns a 302 redirect to app.* for the root domain.
# If you serve your own site on the root domain, skip this section —
# just point root DNS to your site's hosting instead.
echo ""

# Check if root domain already has a non-placeholder record
ROOT_ANY=$(curl -s "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records?name=${ZONE_NAME}" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json")

ROOT_RECORDS=$(echo "$ROOT_ANY" | python3 -c '
import sys, json
records = json.load(sys.stdin).get("result", [])
root = [r for r in records if r["type"] in ("A", "AAAA", "CNAME")]
for r in root:
    print("{} {}".format(r["type"], r["content"]))
')

ROOT_CLASSIFICATION=$(echo "$ROOT_ANY" | python3 - "$ALB_DNS" <<'PY'
import json
import sys

alb_dns = sys.argv[1].rstrip(".")
records = json.load(sys.stdin).get("result", [])
managed_cname_id = ""
external_records = []

for record in records:
    record_type = record.get("type", "")
    content = str(record.get("content", "")).rstrip(".")
    if record_type not in ("A", "AAAA", "CNAME"):
        continue

    if record_type == "A" and content == "192.0.2.1":
        continue

    if record_type == "CNAME" and (content == alb_dns or ".elb.amazonaws.com" in content):
        if managed_cname_id == "":
            managed_cname_id = str(record.get("id", ""))
        continue

    external_records.append(f"{record_type} {content}")

print(managed_cname_id)
print("\n".join(external_records))
PY
)
ROOT_MANAGED_CNAME_ID=$(echo "$ROOT_CLASSIFICATION" | sed -n '1p')
ROOT_EXTERNAL_RECORDS=$(echo "$ROOT_CLASSIFICATION" | sed '1d')

# If a non-placeholder/non-ALB record exists, skip (user manages root domain themselves)
if [[ -n "$ROOT_EXTERNAL_RECORDS" ]]; then
  echo "Root domain already has DNS records — skipping (managed externally):"
  echo "$ROOT_EXTERNAL_RECORDS" | sed 's/^/  /'
  echo "To use the ALB redirect instead, remove the existing root record in Cloudflare and re-run."
else
  echo "Setting up root domain CNAME -> ${ALB_DNS} (redirect to app.*)..."

  # Delete placeholder A record (192.0.2.1) if left over from previous setup
  PLACEHOLDER=$(curl -s "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records?name=${ZONE_NAME}&type=A&content=192.0.2.1" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "Content-Type: application/json")

  PLACEHOLDER_COUNT=$(echo "$PLACEHOLDER" | python3 -c 'import sys,json; print(len(json.load(sys.stdin).get("result", [])))')

  if [[ "$PLACEHOLDER_COUNT" -gt 0 ]]; then
    PLACEHOLDER_ID=$(echo "$PLACEHOLDER" | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"][0]["id"])')
    echo "Deleting placeholder A record (192.0.2.1)..."
    curl -s -X DELETE "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records/${PLACEHOLDER_ID}" \
      -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
      -H "Content-Type: application/json" | assert_cloudflare_success
  fi

  if [[ -n "$ROOT_MANAGED_CNAME_ID" ]]; then
    # Update root CNAME → current ALB (Cloudflare CNAME flattening handles apex automatically)
    curl -s -X PUT "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records/${ROOT_MANAGED_CNAME_ID}" \
      -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
      -H "Content-Type: application/json" \
      --data "{
        \"type\": \"CNAME\",
        \"name\": \"@\",
        \"content\": \"${ALB_DNS}\",
        \"ttl\": 1,
        \"proxied\": true
      }" | assert_cloudflare_success
  else
    # Create root CNAME → ALB (Cloudflare CNAME flattening handles apex automatically)
    curl -s -X POST "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records" \
      -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
      -H "Content-Type: application/json" \
      --data "{
        \"type\": \"CNAME\",
        \"name\": \"@\",
        \"content\": \"${ALB_DNS}\",
        \"ttl\": 1,
        \"proxied\": true
      }" | assert_cloudflare_success
  fi

  echo "Root domain DNS: ${ZONE_NAME} -> ${ALB_DNS} (Cloudflare proxied, redirects to app.*)"
fi

# --- Set SSL/TLS mode to Full (Strict) ---
echo "Setting SSL/TLS mode to Full (Strict)..."

# Disable automatic SSL/TLS (switch to custom mode)
SSL_AUTOMATIC_RESULT=$(curl -s -X PATCH "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/settings/ssl_automatic_mode" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"value":"custom"}')

echo "$SSL_AUTOMATIC_RESULT" | assert_required_cloudflare_success \
  "Could not disable Cloudflare automatic SSL/TLS mode for zone ${CLOUDFLARE_ZONE_ID}." \
  "Check token permission Zone:Zone Settings:Edit, or manually set SSL/TLS mode to Full (Strict) in Cloudflare Dashboard > SSL/TLS > Overview."

SSL_RESULT=$(curl -s -X PATCH "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/settings/ssl" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"value":"strict"}')

echo "$SSL_RESULT" | assert_required_cloudflare_success \
  "Could not set Cloudflare SSL/TLS mode to Full (Strict) for zone ${CLOUDFLARE_ZONE_ID}." \
  "Check token permission Zone:Zone Settings:Edit, or manually set Cloudflare Dashboard > SSL/TLS > Overview > Full (Strict)."

echo "SSL/TLS mode set to Full (Strict)."

# --- Bypass Cloudflare cache for app ---
# The app is fully dynamic (auth cookies, CSRF tokens, real-time data).
# Edge caching provides no benefit and can break auth flows.
echo ""
echo "Setting up cache bypass rule for app..."

CACHE_EXPRESSION="(http.host eq \"${APP_FQDN}\" or http.host eq \"${AUTH_FQDN}\" or http.host eq \"${ZONE_NAME}\")"
CACHE_RULE_DESCRIPTION="Bypass cache for app — fully dynamic content"

CACHE_RULESET=$(curl -s \
  "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/rulesets/phases/http_request_cache_settings/entrypoint" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json")

CACHE_PAYLOAD=$(echo "$CACHE_RULESET" | build_cache_ruleset_payload "$CACHE_RULE_DESCRIPTION" "$CACHE_EXPRESSION")

CACHE_RESULT=$(curl -s -X PUT \
  "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/rulesets/phases/http_request_cache_settings/entrypoint" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$CACHE_PAYLOAD")

echo "$CACHE_RESULT" | assert_required_cloudflare_success \
  "Could not set Cloudflare cache bypass rule for ${APP_FQDN}, ${AUTH_FQDN}, and ${ZONE_NAME}." \
  "Check token permission Zone:Cache Rules:Edit, or manually add a Cache Rules bypass for expression: ${CACHE_EXPRESSION}"

echo "Cache bypass rule set for ${APP_FQDN}, ${AUTH_FQDN}, and ${ZONE_NAME}."

# --- API Gateway custom domain CNAME (optional) ---
# Created only when apiCertificateArn is set in CDK context (custom domain for machine clients).
API_DOMAIN_TARGET=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  "${AWS_ARGS[@]}" \
  --query "Stacks[0].Outputs[?OutputKey=='ApiCustomDomain'].OutputValue" \
  --output text 2>/dev/null || true)

if [[ -n "$API_DOMAIN_TARGET" && "$API_DOMAIN_TARGET" != "None" ]]; then
  API_FQDN="api.${ZONE_NAME}"
  echo ""
  echo "Setting up API Gateway CNAME: ${API_FQDN} -> ${API_DOMAIN_TARGET}..."

  API_EXISTING=$(curl -s "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records?name=${API_FQDN}&type=CNAME" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "Content-Type: application/json")

  API_EXISTING_COUNT=$(echo "$API_EXISTING" | python3 -c 'import sys,json; print(len(json.load(sys.stdin).get("result", [])))')

  if [[ "$API_EXISTING_COUNT" -gt 0 ]]; then
    API_RECORD_ID=$(echo "$API_EXISTING" | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"][0]["id"])')
    echo "Updating existing API CNAME record..."
    curl -s -X PUT "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records/${API_RECORD_ID}" \
      -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
      -H "Content-Type: application/json" \
      --data "{
        \"type\": \"CNAME\",
        \"name\": \"api\",
        \"content\": \"${API_DOMAIN_TARGET}\",
        \"ttl\": 1,
        \"proxied\": true
      }" | assert_cloudflare_success
  else
    echo "Creating CNAME: api -> ${API_DOMAIN_TARGET} (proxied)..."
    curl -s -X POST "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records" \
      -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
      -H "Content-Type: application/json" \
      --data "{
        \"type\": \"CNAME\",
        \"name\": \"api\",
        \"content\": \"${API_DOMAIN_TARGET}\",
        \"ttl\": 1,
        \"proxied\": true
      }" | assert_cloudflare_success
  fi

  echo "API domain ready: https://${API_FQDN}/sql"
else
  echo ""
  echo "No ApiCustomDomain output found — skipping API CNAME."
  echo "  Set apiCertificateArn in cdk.context.local.json and redeploy to enable custom domain."
fi
