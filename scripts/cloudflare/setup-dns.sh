#!/usr/bin/env bash
# Create a Cloudflare DNS CNAME record pointing to the ALB.
# Run once after the first CDK deploy.
#
# Required env vars:
#   CLOUDFLARE_API_TOKEN  — API token with Zone:DNS:Edit permission
#   CLOUDFLARE_ZONE_ID    — Zone ID from Cloudflare dashboard
#   AWS_PROFILE           — AWS CLI profile for the target account
#
# Usage:
#   export CLOUDFLARE_API_TOKEN="..." CLOUDFLARE_ZONE_ID="..." AWS_PROFILE=expense-tracker
#   bash scripts/cloudflare/setup-dns.sh --subdomain app --stack-name ExpenseBudgetTracker

set -euo pipefail

# --- Parse arguments ---
SUBDOMAIN="app"
STACK_NAME="ExpenseBudgetTracker"
while [[ $# -gt 0 ]]; do
  case $1 in
    --subdomain) SUBDOMAIN="$2"; shift 2 ;;
    --stack-name) STACK_NAME="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

: "${CLOUDFLARE_API_TOKEN:?Set CLOUDFLARE_API_TOKEN env var}"
: "${CLOUDFLARE_ZONE_ID:?Set CLOUDFLARE_ZONE_ID env var}"

# --- Get ALB DNS from CloudFormation outputs ---
echo "Reading ALB DNS from CloudFormation stack '${STACK_NAME}'..."

ALB_DNS=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='AlbDns'].OutputValue" \
  --output text)

if [[ -z "$ALB_DNS" || "$ALB_DNS" == "None" ]]; then
  echo "Could not find AlbDns output in stack ${STACK_NAME}" >&2
  exit 1
fi

echo "ALB DNS: ${ALB_DNS}"

# --- Check if record already exists ---
EXISTING=$(curl -s "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records?name=${SUBDOMAIN}&type=CNAME" \
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
    }" | python3 -c 'import sys,json; r=json.load(sys.stdin); print("OK" if r["success"] else json.dumps(r["errors"], indent=2))'
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
    }" | python3 -c 'import sys,json; r=json.load(sys.stdin); print("OK" if r["success"] else json.dumps(r["errors"], indent=2))'
fi

echo ""
echo "DNS record set: ${SUBDOMAIN} -> ${ALB_DNS} (Cloudflare proxied)"
echo ""
echo "IMPORTANT: Set Cloudflare SSL/TLS mode to 'Full (Strict)' in:"
echo "  Cloudflare Dashboard > SSL/TLS > Overview"
