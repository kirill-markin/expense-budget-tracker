#!/usr/bin/env bash
# Create a Cloudflare Origin Certificate and import it into AWS ACM.
# Run once before the first CDK deploy.
#
# Required env vars:
#   CLOUDFLARE_API_TOKEN  — API token with Zone:SSL and Certificates:Edit permissions
#   CLOUDFLARE_ZONE_ID    — Zone ID from Cloudflare dashboard
#   AWS_PROFILE           — AWS CLI profile for the target account
#
# Usage:
#   export CLOUDFLARE_API_TOKEN="..." CLOUDFLARE_ZONE_ID="..." AWS_PROFILE=expense-tracker
#   bash scripts/cloudflare/setup-certificate.sh --domain expense-budget-tracker.com --region eu-central-1

set -euo pipefail

# --- Parse arguments ---
DOMAIN=""
REGION=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --domain) DOMAIN="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$DOMAIN" || -z "$REGION" ]]; then
  echo "Usage: $0 --domain <domain> --region <aws-region>" >&2
  exit 1
fi

: "${CLOUDFLARE_API_TOKEN:?Set CLOUDFLARE_API_TOKEN env var}"
: "${CLOUDFLARE_ZONE_ID:?Set CLOUDFLARE_ZONE_ID env var}"

echo "Creating Cloudflare Origin Certificate for *.${DOMAIN} and ${DOMAIN}..."

# --- Create Origin Certificate via Cloudflare API ---
CERT_RESPONSE=$(curl -s -X POST "https://api.cloudflare.com/client/v4/certificates" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data "{
    \"hostnames\": [\"*.${DOMAIN}\", \"${DOMAIN}\"],
    \"requested_validity\": 5475,
    \"request_type\": \"origin-rsa\",
    \"csr\": \"\"
  }")

SUCCESS=$(echo "$CERT_RESPONSE" | python3 -c 'import sys,json; print(json.load(sys.stdin)["success"])')
if [[ "$SUCCESS" != "True" ]]; then
  echo "Failed to create Cloudflare Origin Certificate:" >&2
  echo "$CERT_RESPONSE" | python3 -c 'import sys,json; print(json.dumps(json.load(sys.stdin).get("errors", []), indent=2))' >&2
  exit 1
fi

# Extract certificate and private key
CERT_PEM=$(echo "$CERT_RESPONSE" | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["certificate"])')
KEY_PEM=$(echo "$CERT_RESPONSE" | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["private_key"])')

echo "Origin Certificate created (15-year validity)."

# --- Import into ACM ---
echo "Importing into AWS ACM (region: ${REGION})..."

CERT_ARN=$(aws acm import-certificate \
  --region "$REGION" \
  --certificate "$CERT_PEM" \
  --private-key "$KEY_PEM" \
  --query "CertificateArn" --output text)

echo ""
echo "Certificate imported into ACM."
echo "ARN: ${CERT_ARN}"
echo ""
echo "Add this to cdk.context.local.json:"
echo "  \"certificateArn\": \"${CERT_ARN}\""
