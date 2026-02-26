#!/usr/bin/env bash
# Create a Cloudflare DNS CNAME record pointing to the ALB.
# Run once after the first CDK deploy.
#
# Required env vars:
#   CLOUDFLARE_API_TOKEN  — API token with Zone:DNS:Edit, Zone:SSL and Certificates:Edit, Zone:Zone Settings:Edit
#   CLOUDFLARE_ZONE_ID    — Zone ID from Cloudflare dashboard
#   AWS_PROFILE           — AWS CLI profile for the target account
#
# Usage:
#   export CLOUDFLARE_API_TOKEN="..." CLOUDFLARE_ZONE_ID="..." AWS_PROFILE=expense-tracker
#   bash scripts/cloudflare/setup-dns.sh --stack-name ExpenseBudgetTracker --auth-domain auth.yourdomain.com

set -euo pipefail

# --- Parse arguments ---
SUBDOMAIN="app"
STACK_NAME="ExpenseBudgetTracker"
AUTH_DOMAIN=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --stack-name) STACK_NAME="$2"; shift 2 ;;
    --auth-domain) AUTH_DOMAIN="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

: "${CLOUDFLARE_API_TOKEN:?Set CLOUDFLARE_API_TOKEN env var}"
: "${CLOUDFLARE_ZONE_ID:?Set CLOUDFLARE_ZONE_ID env var}"

# --- Verify CDK stack exists ---
if ! aws cloudformation describe-stacks --stack-name "$STACK_NAME" &>/dev/null; then
  echo "ERROR: CloudFormation stack '${STACK_NAME}' not found." >&2
  echo "Run 'npx cdk deploy' first (see infra/aws/README.md step 5)." >&2
  exit 1
fi

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

# If a non-placeholder record exists, skip (user manages root domain themselves)
if echo "$ROOT_RECORDS" | grep -qv "192.0.2.1" 2>/dev/null && [[ -n "$ROOT_RECORDS" ]]; then
  echo "Root domain already has DNS records — skipping (managed externally):"
  echo "$ROOT_RECORDS" | sed 's/^/  /'
  echo "To use the ALB redirect instead, remove the existing root record in Cloudflare and re-run."
else
  echo "Setting up root domain CNAME -> ${ALB_DNS} (redirect to app.*)..."

  # Delete placeholder A record (192.0.2.1) if left over from setup-auth-domain.sh
  PLACEHOLDER=$(curl -s "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records?name=${ZONE_NAME}&type=A&content=192.0.2.1" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "Content-Type: application/json")

  PLACEHOLDER_COUNT=$(echo "$PLACEHOLDER" | python3 -c 'import sys,json; print(len(json.load(sys.stdin).get("result", [])))')

  if [[ "$PLACEHOLDER_COUNT" -gt 0 ]]; then
    PLACEHOLDER_ID=$(echo "$PLACEHOLDER" | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"][0]["id"])')
    echo "Deleting placeholder A record (192.0.2.1)..."
    curl -s -X DELETE "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records/${PLACEHOLDER_ID}" \
      -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
      -H "Content-Type: application/json" > /dev/null
  fi

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
    }" | python3 -c 'import sys,json; r=json.load(sys.stdin); print("OK" if r["success"] else json.dumps(r["errors"], indent=2))'

  echo "Root domain DNS: ${ZONE_NAME} -> ${ALB_DNS} (Cloudflare proxied, redirects to app.*)"
fi

# --- Direct DB access: db.* CNAME -> NLB (DNS-only, not proxied) ---
# Cloudflare proxy only handles HTTP/HTTPS; TCP:5432 requires DNS-only mode.
echo ""
echo "Setting up direct DB access DNS record..."

NLB_DNS=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='NlbDns'].OutputValue" \
  --output text)

if [[ -z "$NLB_DNS" || "$NLB_DNS" == "None" ]]; then
  echo "WARNING: Could not find NlbDns output in stack ${STACK_NAME}. Skipping db.* DNS." >&2
else
  echo "NLB DNS: ${NLB_DNS}"
  DB_FQDN="db.${ZONE_NAME}"

  DB_EXISTING=$(curl -s "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records?name=${DB_FQDN}&type=CNAME" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "Content-Type: application/json")

  DB_EXISTING_COUNT=$(echo "$DB_EXISTING" | python3 -c 'import sys,json; print(len(json.load(sys.stdin).get("result", [])))')

  if [[ "$DB_EXISTING_COUNT" -gt 0 ]]; then
    DB_RECORD_ID=$(echo "$DB_EXISTING" | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"][0]["id"])')
    echo "Updating existing db CNAME record (${DB_RECORD_ID})..."
    curl -s -X PUT "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records/${DB_RECORD_ID}" \
      -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
      -H "Content-Type: application/json" \
      --data "{
        \"type\": \"CNAME\",
        \"name\": \"db\",
        \"content\": \"${NLB_DNS}\",
        \"ttl\": 300,
        \"proxied\": false
      }" | python3 -c 'import sys,json; r=json.load(sys.stdin); print("OK" if r["success"] else json.dumps(r["errors"], indent=2))'
  else
    echo "Creating CNAME record: db -> ${NLB_DNS} (DNS-only)..."
    curl -s -X POST "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records" \
      -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
      -H "Content-Type: application/json" \
      --data "{
        \"type\": \"CNAME\",
        \"name\": \"db\",
        \"content\": \"${NLB_DNS}\",
        \"ttl\": 300,
        \"proxied\": false
      }" | python3 -c 'import sys,json; r=json.load(sys.stdin); print("OK" if r["success"] else json.dumps(r["errors"], indent=2))'
  fi

  echo "DB DNS record set: db.${ZONE_NAME} -> ${NLB_DNS} (DNS-only, not proxied)"
fi

# --- Set SSL/TLS mode to Full (Strict) ---
echo "Setting SSL/TLS mode to Full (Strict)..."

# Disable automatic SSL/TLS (switch to custom mode)
curl -s -X PATCH "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/settings/ssl_automatic_mode" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"value":"custom"}' > /dev/null

SSL_RESULT=$(curl -s -X PATCH "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/settings/ssl" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"value":"strict"}')

SSL_SUCCESS=$(echo "$SSL_RESULT" | python3 -c 'import sys,json; print(json.load(sys.stdin)["success"])')
if [[ "$SSL_SUCCESS" == "True" ]]; then
  echo "SSL/TLS mode set to Full (Strict)."
else
  echo "WARNING: Could not set SSL/TLS mode via API. Set it manually:" >&2
  echo "  Cloudflare Dashboard > SSL/TLS > Overview > Full (Strict)" >&2
fi

# --- Custom auth domain CNAME (optional) ---
if [[ -n "$AUTH_DOMAIN" ]]; then
  echo ""
  echo "Setting up custom auth domain CNAME: ${AUTH_DOMAIN}..."

  # Get Cognito User Pool ID from stack outputs
  USER_POOL_ID=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?OutputKey=='CognitoUserPoolId'].OutputValue" \
    --output text)

  if [[ -z "$USER_POOL_ID" || "$USER_POOL_ID" == "None" ]]; then
    echo "WARNING: Could not find CognitoUserPoolId in stack outputs. Skipping auth CNAME." >&2
  else
    # Get CloudFront distribution for the custom domain
    CF_DIST=$(aws cognito-idp describe-user-pool-domain \
      --domain "$AUTH_DOMAIN" \
      --query "DomainDescription.CloudFrontDistribution" \
      --output text)

    if [[ -z "$CF_DIST" || "$CF_DIST" == "None" ]]; then
      echo "WARNING: Cognito custom domain CloudFront distribution not ready yet." >&2
      echo "  Wait a few minutes and re-run this script with --auth-domain ${AUTH_DOMAIN}" >&2
    else
      echo "Cognito CloudFront: ${CF_DIST}"

      # Create or update auth CNAME (DNS-only, not proxied — required for Cognito/CloudFront)
      AUTH_EXISTING=$(curl -s "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records?name=${AUTH_DOMAIN}&type=CNAME" \
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
            \"name\": \"${AUTH_DOMAIN}\",
            \"content\": \"${CF_DIST}\",
            \"ttl\": 300,
            \"proxied\": false
          }" | python3 -c 'import sys,json; r=json.load(sys.stdin); print("OK" if r["success"] else json.dumps(r["errors"], indent=2))'
      else
        echo "Creating auth CNAME: ${AUTH_DOMAIN} -> ${CF_DIST} (DNS-only)..."
        curl -s -X POST "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records" \
          -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
          -H "Content-Type: application/json" \
          --data "{
            \"type\": \"CNAME\",
            \"name\": \"${AUTH_DOMAIN}\",
            \"content\": \"${CF_DIST}\",
            \"ttl\": 300,
            \"proxied\": false
          }" | python3 -c 'import sys,json; r=json.load(sys.stdin); print("OK" if r["success"] else json.dumps(r["errors"], indent=2))'
      fi

      echo "Auth domain ready: https://${AUTH_DOMAIN}"
    fi
  fi
fi
