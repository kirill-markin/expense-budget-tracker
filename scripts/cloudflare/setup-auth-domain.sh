#!/usr/bin/env bash
# Create an ACM public certificate for a custom Cognito auth domain and validate via Cloudflare DNS.
# Run once before CDK deploy (only if you want a custom login domain like auth.yourdomain.com).
#
# Required env vars:
#   CLOUDFLARE_API_TOKEN  — API token with Zone:DNS:Edit, Zone:SSL and Certificates:Edit, Zone:Zone Settings:Edit
#   CLOUDFLARE_ZONE_ID    — Zone ID from Cloudflare
#   AWS_PROFILE           — AWS CLI profile for the target account
#
# Usage:
#   export CLOUDFLARE_API_TOKEN="..." CLOUDFLARE_ZONE_ID="..." AWS_PROFILE=expense-tracker
#   bash scripts/cloudflare/setup-auth-domain.sh --domain expense-budget-tracker.com

set -euo pipefail

# --- Parse arguments ---
DOMAIN=""
AUTH_SUBDOMAIN="auth"
while [[ $# -gt 0 ]]; do
  case $1 in
    --domain) DOMAIN="$2"; shift 2 ;;
    --auth-subdomain) AUTH_SUBDOMAIN="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$DOMAIN" ]]; then
  echo "Usage: $0 --domain <domain> [--auth-subdomain <subdomain>]" >&2
  exit 1
fi

: "${CLOUDFLARE_API_TOKEN:?Set CLOUDFLARE_API_TOKEN env var}"
: "${CLOUDFLARE_ZONE_ID:?Set CLOUDFLARE_ZONE_ID env var}"

AUTH_DOMAIN="${AUTH_SUBDOMAIN}.${DOMAIN}"

# --- Step 1: Request ACM certificate in us-east-1 ---
# Cognito custom domains use CloudFront, which requires certificates in us-east-1.
echo "Requesting ACM certificate for ${AUTH_DOMAIN} in us-east-1..."

CERT_ARN=$(aws acm request-certificate \
  --region us-east-1 \
  --domain-name "$AUTH_DOMAIN" \
  --validation-method DNS \
  --query "CertificateArn" --output text)

echo "Certificate ARN: ${CERT_ARN}"

# --- Step 2: Wait for validation record to appear ---
echo "Waiting for ACM to generate validation DNS record..."

VALIDATION_JSON=""
for i in $(seq 1 24); do
  VALIDATION_JSON=$(aws acm describe-certificate \
    --region us-east-1 \
    --certificate-arn "$CERT_ARN" \
    --query "Certificate.DomainValidationOptions[0].ResourceRecord" \
    --output json)
  if [[ "$VALIDATION_JSON" != "null" ]]; then
    break
  fi
  sleep 5
done

if [[ "$VALIDATION_JSON" == "null" || -z "$VALIDATION_JSON" ]]; then
  echo "Timed out waiting for ACM validation record." >&2
  echo "Certificate ARN: ${CERT_ARN}" >&2
  echo "Check manually: aws acm describe-certificate --region us-east-1 --certificate-arn ${CERT_ARN}" >&2
  exit 1
fi

# Strip trailing dots (Cloudflare API does not want them)
VALIDATION_NAME=$(echo "$VALIDATION_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['Name'].rstrip('.'))")
VALIDATION_VALUE=$(echo "$VALIDATION_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['Value'].rstrip('.'))")

echo "Validation CNAME: ${VALIDATION_NAME} -> ${VALIDATION_VALUE}"

# --- Step 3: Create validation CNAME in Cloudflare (DNS-only, not proxied) ---
echo "Creating ACM validation CNAME in Cloudflare (DNS-only)..."

# Check if record already exists
EXISTING=$(curl -s "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records?name=${VALIDATION_NAME}&type=CNAME" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json")

EXISTING_COUNT=$(echo "$EXISTING" | python3 -c 'import sys,json; print(len(json.load(sys.stdin).get("result", [])))')

if [[ "$EXISTING_COUNT" -gt 0 ]]; then
  RECORD_ID=$(echo "$EXISTING" | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"][0]["id"])')
  curl -s -X PUT "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records/${RECORD_ID}" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "{
      \"type\": \"CNAME\",
      \"name\": \"${VALIDATION_NAME}\",
      \"content\": \"${VALIDATION_VALUE}\",
      \"ttl\": 120,
      \"proxied\": false
    }" | python3 -c 'import sys,json; r=json.load(sys.stdin); print("OK" if r["success"] else json.dumps(r["errors"], indent=2))'
else
  curl -s -X POST "https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/dns_records" \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "{
      \"type\": \"CNAME\",
      \"name\": \"${VALIDATION_NAME}\",
      \"content\": \"${VALIDATION_VALUE}\",
      \"ttl\": 120,
      \"proxied\": false
    }" | python3 -c 'import sys,json; r=json.load(sys.stdin); print("OK" if r["success"] else json.dumps(r["errors"], indent=2))'
fi

# --- Step 4: Wait for certificate to be ISSUED ---
echo "Waiting for ACM certificate validation (this may take 5-30 minutes)..."

aws acm wait certificate-validated \
  --region us-east-1 \
  --certificate-arn "$CERT_ARN"

echo ""
echo "Certificate ISSUED."
echo "ARN: ${CERT_ARN}"
echo ""
echo "Add this to cdk.context.local.json:"
echo "  \"authCertificateArn\": \"${CERT_ARN}\""
echo ""
echo "Do NOT delete the validation CNAME record — ACM needs it for automatic renewal."
