#!/usr/bin/env bash
# Create an ACM public certificate for the API Gateway custom domain and validate via Cloudflare DNS.
# Run once before CDK deploy (only if you want a custom API domain like api.yourdomain.com).
#
# API Gateway custom domains require a publicly trusted certificate (Cloudflare Origin
# Certificates are not accepted). ACM public certificates are free and auto-renew.
#
# Required env vars:
#   CLOUDFLARE_API_TOKEN  — API token with Zone:DNS:Edit
#   CLOUDFLARE_ZONE_ID    — Zone ID from Cloudflare
#   AWS_PROFILE           — AWS CLI profile for the target account
#
# Usage from the repository root; the parent shell never receives the token:
#   (
#     set -euo pipefail
#     set -a
#     source scripts/cloudflare/.env
#     set +a
#     export AWS_PROFILE=expense-tracker
#     bash scripts/cloudflare/setup-api-domain.sh --domain expense-budget-tracker.com --region eu-central-1
#   )

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/cloudflare-api.sh"

# --- Parse arguments ---
DOMAIN=""
REGION=""
API_SUBDOMAIN="api"
while [[ $# -gt 0 ]]; do
  case $1 in
    --domain) DOMAIN="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --api-subdomain) API_SUBDOMAIN="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$DOMAIN" || -z "$REGION" ]]; then
  echo "Usage: $0 --domain <domain> --region <region> [--api-subdomain <subdomain>]" >&2
  exit 1
fi

cloudflare_require_api_token
: "${CLOUDFLARE_ZONE_ID:?Set CLOUDFLARE_ZONE_ID env var}"

API_DOMAIN="${API_SUBDOMAIN}.${DOMAIN}"

# --- Step 1: Request ACM certificate ---
# API Gateway regional custom domain requires the certificate in the same region as the API.
echo "Requesting ACM certificate for ${API_DOMAIN} in ${REGION}..."

CERT_ARN=$(aws acm request-certificate \
  --region "$REGION" \
  --domain-name "$API_DOMAIN" \
  --validation-method DNS \
  --query "CertificateArn" --output text)

echo "Certificate ARN: ${CERT_ARN}"

# --- Step 2: Wait for validation record to appear ---
echo "Waiting for ACM to generate validation DNS record..."

VALIDATION_JSON=""
for i in $(seq 1 24); do
  VALIDATION_JSON=$(aws acm describe-certificate \
    --region "$REGION" \
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
  echo "Check manually: aws acm describe-certificate --region ${REGION} --certificate-arn ${CERT_ARN}" >&2
  exit 1
fi

# Strip trailing dots (Cloudflare API does not want them)
VALIDATION_NAME=$(echo "$VALIDATION_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['Name'].rstrip('.'))")
VALIDATION_VALUE=$(echo "$VALIDATION_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['Value'].rstrip('.'))")

echo "Validation CNAME: ${VALIDATION_NAME} -> ${VALIDATION_VALUE}"

# --- Step 3: Create validation CNAME in Cloudflare (DNS-only, not proxied) ---
echo "Creating ACM validation CNAME in Cloudflare (DNS-only)..."

EXISTING=$(cloudflare_read_all_dns_records \
  "read all DNS records for API certificate validation hostname ${VALIDATION_NAME}" \
  "/zones/${CLOUDFLARE_ZONE_ID}/dns_records?name=${VALIDATION_NAME}&per_page=100")
EXISTING_RECORD=$(echo "$EXISTING" | cloudflare_classify_exact_cname \
  "$VALIDATION_NAME" \
  "$VALIDATION_VALUE" \
  "false" \
  "setup-api-domain.sh")
EXISTING_STATE=$(echo "$EXISTING_RECORD" | python3 -c 'import json,sys; print(json.load(sys.stdin)["state"])')
EXISTING_ID=$(echo "$EXISTING_RECORD" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')

VALIDATION_PAYLOAD=$(python3 -c '
import json
import sys

print(json.dumps({
    "type": "CNAME",
    "name": sys.argv[1],
    "content": sys.argv[2],
    "ttl": 120,
    "proxied": False,
}))
' "$VALIDATION_NAME" "$VALIDATION_VALUE")

if [[ "$EXISTING_STATE" == "exact" ]]; then
  echo "API certificate validation CNAME already matches and is DNS-only; reusing it."
elif [[ "$EXISTING_STATE" == "drift" ]]; then
  cloudflare_api_request \
    "update API certificate validation CNAME ${VALIDATION_NAME}" \
    "PUT" \
    "/zones/${CLOUDFLARE_ZONE_ID}/dns_records/${EXISTING_ID}" \
    "$VALIDATION_PAYLOAD" >/dev/null
elif [[ "$EXISTING_STATE" == "absent" ]]; then
  cloudflare_api_request \
    "create API certificate validation CNAME ${VALIDATION_NAME}" \
    "POST" \
    "/zones/${CLOUDFLARE_ZONE_ID}/dns_records" \
    "$VALIDATION_PAYLOAD" \
    "/zones/${CLOUDFLARE_ZONE_ID}/dns_records?name=${VALIDATION_NAME}&per_page=100" >/dev/null
else
  echo "ERROR: Unexpected DNS reconciliation state '${EXISTING_STATE}' for API certificate validation hostname ${VALIDATION_NAME}." >&2
  exit 1
fi
echo "ACM validation CNAME is configured as DNS-only."

# --- Step 4: Wait for certificate to be ISSUED ---
echo "Waiting for ACM certificate validation (this may take 5-30 minutes)..."

aws acm wait certificate-validated \
  --region "$REGION" \
  --certificate-arn "$CERT_ARN"

echo ""
echo "Certificate ISSUED."
echo "ARN: ${CERT_ARN}"
echo ""
echo "Add this to cdk.context.local.json:"
echo "  \"apiCertificateArn\": \"${CERT_ARN}\""
echo ""
echo "Do NOT delete the validation CNAME record — ACM needs it for automatic renewal."
echo ""
echo "Next steps:"
echo "  1. Add apiCertificateArn to cdk.context.local.json"
echo "  2. Run: npx cdk deploy"
echo "  3. Run setup-dns.sh using the credential-isolated subshell in infra/aws/README.md step 6"
echo "     (setup-dns.sh will automatically create the api.* CNAME from the ApiCustomDomain stack output)"
