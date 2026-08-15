#!/usr/bin/env bash
# Create a Cloudflare Origin Certificate and import it into AWS ACM.
# Run once before the first CDK deploy.
#
# Required env vars:
#   CLOUDFLARE_API_TOKEN  — API token with Zone:SSL and Certificates:Edit permissions
#   CLOUDFLARE_ZONE_ID    — Zone ID from Cloudflare dashboard
#   AWS_PROFILE           — AWS CLI profile for the target account
#
# Usage from the repository root; the parent shell never receives the token:
#   (
#     set -euo pipefail
#     set -a
#     source scripts/cloudflare/.env
#     set +a
#     export AWS_PROFILE=expense-tracker
#     bash scripts/cloudflare/setup-certificate.sh --domain expense-budget-tracker.com --region eu-central-1
#   )
# Replace the final command with the printed --resume-dir command when resuming.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/cloudflare-api.sh"

# --- Parse arguments ---
DOMAIN=""
REGION=""
RESUME_DIR=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --domain) DOMAIN="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --resume-dir) RESUME_DIR="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$DOMAIN" || -z "$REGION" ]]; then
  echo "Usage: $0 --domain <domain> --region <aws-region> [--resume-dir <retained-directory>]" >&2
  exit 1
fi

cloudflare_require_api_token
: "${CLOUDFLARE_ZONE_ID:?Set CLOUDFLARE_ZONE_ID env var}"

cloudflare_prepare_curl_config
PRESERVE_CERTIFICATE_REQUEST=false
if [[ -n "$RESUME_DIR" ]]; then
  if [[ ! -d "$RESUME_DIR" || -L "$RESUME_DIR" ]]; then
    echo "ERROR: Retained Origin CA recovery directory must exist and must not be a symlink: ${RESUME_DIR}" >&2
    exit 1
  fi
  TMPDIR_CERT="$RESUME_DIR"
  PRESERVE_CERTIFICATE_REQUEST=true
else
  previous_umask=$(umask)
  umask 077
  TMPDIR_CERT=$(mktemp -d)
  umask "$previous_umask"
fi
KEY_FILE="${TMPDIR_CERT}/origin.key"
CSR_FILE="${TMPDIR_CERT}/origin.csr"
CERT_FILE="${TMPDIR_CERT}/origin.crt"
KEY_PUBLIC_FILE="${TMPDIR_CERT}/origin-key-public.der"
CSR_PUBLIC_FILE="${TMPDIR_CERT}/origin-csr-public.der"
CERT_PUBLIC_FILE="${TMPDIR_CERT}/origin-cert-public.der"
RECOVERY_INSTRUCTIONS_PRINTED=false
RECOVERY_REASON="Origin CA reconciliation did not complete."

print_origin_ca_recovery_instructions() {
  if [[ "$RECOVERY_INSTRUCTIONS_PRINTED" == "true" ]]; then
    return
  fi
  RECOVERY_INSTRUCTIONS_PRINTED=true
  echo "ERROR: ${RECOVERY_REASON}" >&2
  echo "Retained CSR: ${CSR_FILE}" >&2
  echo "Retained private key: ${KEY_FILE}" >&2
  echo "ACTION: Keep these files private and resume GET-only reconciliation; do not start a fresh create." >&2
  echo "ACTION: In the credential-isolated subshell from infra/aws/README.md step 3d, replace the final command with:" >&2
  printf '  bash %q --domain %q --region %q --resume-dir %q\n' "$0" "$DOMAIN" "$REGION" "$TMPDIR_CERT" >&2
}

cleanup() {
  cloudflare_cleanup_curl_config
  rm -f -- "$CERT_FILE" "$KEY_PUBLIC_FILE" "$CSR_PUBLIC_FILE" "$CERT_PUBLIC_FILE"
  if [[ "$PRESERVE_CERTIFICATE_REQUEST" == "true" ]]; then
    if ! chmod 700 "$TMPDIR_CERT" || ! chmod 600 "$KEY_FILE" "$CSR_FILE"; then
      echo "ERROR: Could not restore restricted permissions on retained Origin CA recovery files in ${TMPDIR_CERT}. Secure them immediately." >&2
    fi
    print_origin_ca_recovery_instructions
    return
  fi
  rm -f -- "$KEY_FILE" "$CSR_FILE"
  if [[ -d "$TMPDIR_CERT" ]] && ! rmdir -- "$TMPDIR_CERT"; then
    echo "WARNING: Temporary Origin CA directory ${TMPDIR_CERT} contains unexpected files and was not removed." >&2
  fi
}
trap 'cleanup' EXIT
trap 'cleanup; exit 129' HUP
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

preserve_unknown_origin_ca_request() {
  PRESERVE_CERTIFICATE_REQUEST=true
  RECOVERY_REASON="The Cloudflare Origin CA create outcome is unknown. No second certificate request was sent."
  rm -f -- "$CERT_FILE" "$KEY_PUBLIC_FILE" "$CSR_PUBLIC_FILE" "$CERT_PUBLIC_FILE"
  if ! chmod 700 "$TMPDIR_CERT" || ! chmod 600 "$KEY_FILE" "$CSR_FILE"; then
    echo "ERROR: Could not restrict retained Origin CA recovery files in ${TMPDIR_CERT}. Secure them immediately." >&2
  fi
  print_origin_ca_recovery_instructions
}

if [[ -n "$RESUME_DIR" ]]; then
  if [[ ! -f "$KEY_FILE" || -L "$KEY_FILE" || ! -f "$CSR_FILE" || -L "$CSR_FILE" ]]; then
    echo "ERROR: ${TMPDIR_CERT} must contain regular, non-symlink origin.key and origin.csr recovery files." >&2
    exit 1
  fi
  if ! chmod 700 "$TMPDIR_CERT" || ! chmod 600 "$KEY_FILE" "$CSR_FILE"; then
    echo "ERROR: Could not enforce mode 0700/0600 on retained Origin CA recovery files in ${TMPDIR_CERT}." >&2
    exit 1
  fi
  if ! openssl req -in "$CSR_FILE" -noout -verify >/dev/null 2>&1; then
    echo "ERROR: Retained Origin CA CSR is invalid: ${CSR_FILE}" >&2
    exit 1
  fi
  if ! openssl pkey -in "$KEY_FILE" -pubout -outform DER >"$KEY_PUBLIC_FILE" 2>/dev/null; then
    echo "ERROR: Retained Origin CA private key is invalid: ${KEY_FILE}" >&2
    exit 1
  fi
  if ! openssl req -in "$CSR_FILE" -pubkey -noout \
    | openssl pkey -pubin -outform DER >"$CSR_PUBLIC_FILE" 2>/dev/null; then
    echo "ERROR: Could not extract the public key from retained Origin CA CSR: ${CSR_FILE}" >&2
    exit 1
  fi
  if ! cmp -s "$KEY_PUBLIC_FILE" "$CSR_PUBLIC_FILE"; then
    echo "ERROR: Retained Origin CA private key does not match the retained CSR in ${TMPDIR_CERT}." >&2
    exit 1
  fi
  rm -f -- "$KEY_PUBLIC_FILE" "$CSR_PUBLIC_FILE"
  echo "Resuming Cloudflare Origin Certificate reconciliation for *.${DOMAIN} and ${DOMAIN}; no create request will be sent..."
else
  echo "Creating Cloudflare Origin Certificate for *.${DOMAIN} and ${DOMAIN}..."
  openssl req -new -newkey rsa:2048 -nodes \
    -keyout "$KEY_FILE" \
    -out "$CSR_FILE" \
    -subj "/CN=${DOMAIN}" 2>/dev/null
  chmod 600 "$KEY_FILE" "$CSR_FILE"
fi

# --- Create Origin Certificate via Cloudflare API ---
CERT_PAYLOAD=$(python3 -c '
import json, sys
csr = open(sys.argv[1]).read()
print(json.dumps({
    "hostnames": ["*." + sys.argv[2], sys.argv[2]],
    "requested_validity": 5475,
    "request_type": "origin-rsa",
    "csr": csr
}))
' "$CSR_FILE" "$DOMAIN")

ORIGIN_CA_RECONCILIATION_PATH="/certificates?zone_id=${CLOUDFLARE_ZONE_ID}&per_page=50"
if [[ -n "$RESUME_DIR" ]]; then
  if CERT_RESPONSE=$(cloudflare_reconcile_origin_certificate_create \
    "resume Origin Certificate reconciliation for ${DOMAIN}" \
    "$ORIGIN_CA_RECONCILIATION_PATH" \
    "$CERT_PAYLOAD"); then
    :
  else
    request_status=$?
    preserve_unknown_origin_ca_request
    exit "$request_status"
  fi
else
  if CERT_RESPONSE=$(cloudflare_api_request \
    "create Origin Certificate for ${DOMAIN}" \
    "POST" \
    "/certificates" \
    "$CERT_PAYLOAD" \
    "$ORIGIN_CA_RECONCILIATION_PATH"); then
    :
  else
    request_status=$?
    if [[ "$request_status" -eq "$CLOUDFLARE_API_UNKNOWN_OUTCOME_STATUS" ]]; then
      preserve_unknown_origin_ca_request
    fi
    exit "$request_status"
  fi
fi

PRESERVE_CERTIFICATE_REQUEST=true
RECOVERY_REASON="Cloudflare issued the Origin CA certificate, but certificate validation or ACM import did not complete."

# Extract signed certificate to file
echo "$CERT_RESPONSE" | python3 -c '
import json
import sys

result = json.load(sys.stdin).get("result")
certificate = result.get("certificate") if isinstance(result, dict) else None
if not isinstance(certificate, str) or not certificate.strip():
    print("ERROR: Cloudflare Origin Certificate response did not contain a certificate.", file=sys.stderr)
    raise SystemExit(1)
print(certificate)
' > "$CERT_FILE"

if ! openssl x509 -in "$CERT_FILE" -noout >/dev/null 2>&1; then
  echo "ERROR: Cloudflare Origin CA response is not a valid X.509 certificate." >&2
  exit 1
fi
if ! openssl pkey -in "$KEY_FILE" -pubout -outform DER >"$KEY_PUBLIC_FILE" 2>/dev/null; then
  echo "ERROR: Could not extract the retained Origin CA private-key public key." >&2
  exit 1
fi
if ! openssl x509 -in "$CERT_FILE" -pubkey -noout \
  | openssl pkey -pubin -outform DER >"$CERT_PUBLIC_FILE" 2>/dev/null; then
  echo "ERROR: Could not extract the issued Origin CA certificate public key." >&2
  exit 1
fi
if ! cmp -s "$KEY_PUBLIC_FILE" "$CERT_PUBLIC_FILE"; then
  echo "ERROR: Issued Origin CA certificate does not match the retained private key." >&2
  exit 1
fi
rm -f -- "$KEY_PUBLIC_FILE" "$CERT_PUBLIC_FILE"

echo "Origin Certificate created (15-year validity)."

# --- Import into ACM ---
echo "Importing into AWS ACM (region: ${REGION})..."

CERT_ARN=$(aws acm import-certificate \
  --region "$REGION" \
  --certificate "fileb://${CERT_FILE}" \
  --private-key "fileb://${KEY_FILE}" \
  --query "CertificateArn" --output text)

if [[ ! "$CERT_ARN" =~ ^arn:[^:]+:acm:${REGION}:[0-9]{12}:certificate/.+ ]]; then
  echo "ERROR: ACM import returned an invalid certificate ARN for region ${REGION}: ${CERT_ARN}" >&2
  exit 1
fi

PRESERVE_CERTIFICATE_REQUEST=false

echo ""
echo "Certificate imported into ACM."
echo "ARN: ${CERT_ARN}"
echo ""
echo "Add this to cdk.context.local.json:"
echo "  \"certificateArn\": \"${CERT_ARN}\""
