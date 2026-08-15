#!/usr/bin/env bash
# Create and validate the public ACM certificate required by the regional MCP API domain.
# Requires CLOUDFLARE_API_TOKEN, CLOUDFLARE_ZONE_ID, AWS_PROFILE, and AWS_REGION.
# Usage from the repository root; the parent shell never receives the token:
#   (
#     set -euo pipefail
#     set -a
#     source scripts/cloudflare/.env
#     set +a
#     export AWS_PROFILE=expense-tracker AWS_REGION=eu-central-1
#     bash scripts/cloudflare/setup-mcp-domain.sh --domain expense-budget-tracker.com
#   )

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CDK_CONTEXT_FILE="${ROOT_DIR}/infra/aws/cdk.context.local.json"
source "${SCRIPT_DIR}/cloudflare-api.sh"
source "${SCRIPT_DIR}/aws-api.sh"

DOMAIN=""
PROFILE="${AWS_PROFILE:-}"
REGION="${AWS_REGION:-}"
while [[ $# -gt 0 ]]; do
  case $1 in
    --domain) DOMAIN="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$DOMAIN" ]]; then
  echo "Usage: AWS_PROFILE=<profile> AWS_REGION=<region> $0 --domain <domain>" >&2
  exit 1
fi

if [[ -z "$PROFILE" ]]; then
  echo "ERROR: AWS_PROFILE is required and must identify the dedicated deployment account." >&2
  exit 1
fi

if [[ -z "$REGION" ]]; then
  echo "ERROR: AWS_REGION is required and must identify the explicit deployment region." >&2
  exit 1
fi
if [[ ! -f "$CDK_CONTEXT_FILE" ]]; then
  echo "ERROR: ${CDK_CONTEXT_FILE} is required before MCP certificate bootstrap." >&2
  echo "Complete the local deployment context as described in infra/aws/README.md, leaving only mcpCertificateArn empty, then rerun." >&2
  exit 1
fi

cloudflare_require_api_token
: "${CLOUDFLARE_ZONE_ID:?Set CLOUDFLARE_ZONE_ID env var}"
export AWS_PAGER=""

MCP_DOMAIN="mcp.${DOMAIN}"
AWS_ARGS=(--profile "$PROFILE" --region "$REGION")

CONTEXT_EXPECTATIONS=$(python3 - "$CDK_CONTEXT_FILE" <<'PY'
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
    "resendApiKeySecretArn",
    "resendSenderEmail",
    "alertEmail",
    "githubRepo",
]
missing = [
    key for key in required_strings
    if not isinstance(context.get(key), str) or not context[key].strip()
]
if missing:
    print(
        f"ERROR: {context_path} must define non-empty deployment values for: {', '.join(missing)}.",
        file=sys.stderr,
    )
    raise SystemExit(1)

region = context["region"]
account_ids = set()
arn_keys = ["certificateArn", "apiCertificateArn", "resendApiKeySecretArn"]
if isinstance(context.get("mcpCertificateArn"), str) and context["mcpCertificateArn"].strip():
    arn_keys.append("mcpCertificateArn")
for key in arn_keys:
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
    "domainName": context["domainName"],
    "region": region,
}))
PY
)
CONTEXT_REGION=$(echo "$CONTEXT_EXPECTATIONS" | python3 -c 'import json,sys; print(json.load(sys.stdin)["region"])')
CONTEXT_DOMAIN=$(echo "$CONTEXT_EXPECTATIONS" | python3 -c 'import json,sys; print(json.load(sys.stdin)["domainName"])')
CONTEXT_ACCOUNT_COUNT=$(echo "$CONTEXT_EXPECTATIONS" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["accountIds"]))')
if [[ "$CONTEXT_REGION" != "$REGION" ]]; then
  echo "ERROR: AWS region ${REGION} does not match ${CDK_CONTEXT_FILE} region ${CONTEXT_REGION}." >&2
  exit 1
fi
if [[ "$CONTEXT_DOMAIN" != "$DOMAIN" ]]; then
  echo "ERROR: Domain ${DOMAIN} does not match ${CDK_CONTEXT_FILE} domainName ${CONTEXT_DOMAIN}." >&2
  exit 1
fi
if [[ "$CONTEXT_ACCOUNT_COUNT" -ne 1 ]]; then
  echo "ERROR: ${CDK_CONTEXT_FILE} must contain deployment ARNs from exactly one AWS account; found ${CONTEXT_ACCOUNT_COUNT}." >&2
  exit 1
fi
CONTEXT_ACCOUNT_ID=$(echo "$CONTEXT_EXPECTATIONS" | python3 -c 'import json,sys; print(json.load(sys.stdin)["accountIds"][0])')

if ! AWS_IDENTITY=$(aws_api_request \
  "caller identity lookup" \
  "$PROFILE" \
  "$REGION" \
  aws sts get-caller-identity \
  --output json); then
  echo "ERROR: Failed to verify AWS caller identity with profile ${PROFILE} in region ${REGION}." >&2
  echo "Confirm that the profile targets the dedicated deployment account and that its credentials are valid." >&2
  exit 1
fi

AWS_ACCOUNT_ID=$(echo "$AWS_IDENTITY" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("Account", ""))')
AWS_CALLER_ARN=$(echo "$AWS_IDENTITY" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("Arn", ""))')
if [[ ! "$AWS_ACCOUNT_ID" =~ ^[0-9]{12}$ || -z "$AWS_CALLER_ARN" ]]; then
  echo "ERROR: AWS STS returned an invalid caller identity for profile ${PROFILE}." >&2
  exit 1
fi
if [[ "$CONTEXT_ACCOUNT_ID" != "$AWS_ACCOUNT_ID" ]]; then
  echo "ERROR: AWS profile ${PROFILE} resolves to account ${AWS_ACCOUNT_ID}, but ${CDK_CONTEXT_FILE} targets account ${CONTEXT_ACCOUNT_ID}." >&2
  exit 1
fi

CLOUDFLARE_ZONE=$(cloudflare_api_request \
  "read certificate-bootstrap zone" \
  "GET" \
  "/zones/${CLOUDFLARE_ZONE_ID}" \
  "")
CLOUDFLARE_ZONE_NAME=$(echo "$CLOUDFLARE_ZONE" | python3 -c '
import json
import sys
response = json.load(sys.stdin)
if response.get("success") is not True:
    print(json.dumps(response.get("errors", response), indent=2), file=sys.stderr)
    raise SystemExit(1)
result = response.get("result")
name = result.get("name") if isinstance(result, dict) else None
if not isinstance(name, str) or not name:
    print("ERROR: Cloudflare zone lookup returned no domain name.", file=sys.stderr)
    raise SystemExit(1)
print(name)
')
if [[ "$CLOUDFLARE_ZONE_NAME" != "$CONTEXT_DOMAIN" ]]; then
  echo "ERROR: Cloudflare zone ${CLOUDFLARE_ZONE_NAME} does not match ${CDK_CONTEXT_FILE} domainName ${CONTEXT_DOMAIN}." >&2
  exit 1
fi

echo "Verified AWS caller ${AWS_CALLER_ARN} in account ${AWS_ACCOUNT_ID}, region ${REGION}, using profile ${PROFILE}."

find_matching_certificates() {
  local certificate_summaries
  certificate_summaries=$(aws_api_request \
    "list active ACM certificates for ${MCP_DOMAIN}" \
    "$PROFILE" \
    "$REGION" \
    aws acm list-certificates \
    --certificate-statuses ISSUED PENDING_VALIDATION \
    --output json)
  local exact_certificate_arns
  exact_certificate_arns=$(echo "$certificate_summaries" | python3 -c '
import json
import sys

domain = sys.argv[1]
response = json.load(sys.stdin)
summaries = response.get("CertificateSummaryList")
if not isinstance(summaries, list):
    print("ERROR: ACM list-certificates returned no CertificateSummaryList array.", file=sys.stderr)
    raise SystemExit(1)
for summary in summaries:
    if not isinstance(summary, dict) or summary.get("DomainName") != domain:
        continue
    arn = summary.get("CertificateArn")
    if not isinstance(arn, str) or not arn:
        print("ERROR: ACM returned an invalid exact-domain certificate summary.", file=sys.stderr)
        raise SystemExit(1)
    print(arn)
' "$MCP_DOMAIN")

  local described_certificates='[]'
  while IFS= read -r candidate_arn; do
    if [[ -z "$candidate_arn" ]]; then
      continue
    fi
    local candidate_description
    candidate_description=$(aws_api_request \
      "describe ACM certificate ${candidate_arn}" \
      "$PROFILE" \
      "$REGION" \
      aws acm describe-certificate \
      --certificate-arn "$candidate_arn" \
      --query Certificate \
      --output json)
    described_certificates=$(echo "$candidate_description" | python3 -c '
import json
import sys

certificates = json.loads(sys.argv[1])
certificate = json.load(sys.stdin)
if not isinstance(certificates, list) or not isinstance(certificate, dict):
    print("ERROR: ACM describe-certificate returned an invalid certificate object.", file=sys.stderr)
    raise SystemExit(1)
certificates.append(certificate)
print(json.dumps(certificates))
' "$described_certificates")
  done <<< "$exact_certificate_arns"

  echo "$described_certificates" | python3 -c '
import json
import sys

domain = sys.argv[1]
certificates = json.load(sys.stdin)
matches = []
for certificate in certificates:
    arn = certificate.get("CertificateArn")
    status = certificate.get("Status")
    certificate_type = certificate.get("Type")
    primary_domain = certificate.get("DomainName")
    subject_alternative_names = certificate.get("SubjectAlternativeNames")
    validation_options = certificate.get("DomainValidationOptions", [])
    validation_methods = {
        option.get("ValidationMethod")
        for option in validation_options
        if isinstance(option, dict) and option.get("ValidationMethod")
    }
    reasons = []
    if primary_domain != domain:
        reasons.append(f"primary domain is {primary_domain!r}")
    if (
        not isinstance(subject_alternative_names, list)
        or any(not isinstance(name, str) or not name for name in subject_alternative_names)
    ):
        reasons.append("SubjectAlternativeNames is not a valid domain-name array")
    else:
        complete_name_set = set(subject_alternative_names)
        if isinstance(primary_domain, str) and primary_domain:
            complete_name_set.add(primary_domain)
        if complete_name_set != {domain}:
            reasons.append(
                f"complete certificate name set is {sorted(complete_name_set)!r}; expected only {domain!r}"
            )
    if status not in {"ISSUED", "PENDING_VALIDATION"}:
        reasons.append(f"status is {status!r}")
    if certificate_type != "AMAZON_ISSUED":
        reasons.append(f"type is {certificate_type!r}")
    if validation_methods != {"DNS"}:
        reasons.append(f"validation methods are {sorted(validation_methods)!r}")
    if not isinstance(arn, str) or not arn:
        print("ERROR: ACM describe-certificate returned a certificate without an ARN.", file=sys.stderr)
        raise SystemExit(1)
    if reasons:
        print("Ignoring unsuitable exact-domain certificate {}: {}.".format(arn, "; ".join(reasons)), file=sys.stderr)
        continue
    matches.append({
        "arn": arn,
        "status": status,
        "type": certificate_type,
        "validationMethod": "DNS",
    })
print(json.dumps(matches))
' "$MCP_DOMAIN"
}

request_certificate_with_reconciliation() {
  local idempotency_token
  idempotency_token=$(printf '%s' "${AWS_ACCOUNT_ID}:${REGION}:${MCP_DOMAIN}" | shasum -a 256 | cut -c1-32)
  local error_file
  error_file=$(mktemp)
  local attempt=1

  while [[ "$attempt" -le 3 ]]; do
    local requested_arn
    local command_status
    if requested_arn=$(aws acm request-certificate \
      "${AWS_ARGS[@]}" \
      --domain-name "$MCP_DOMAIN" \
      --validation-method DNS \
      --idempotency-token "$idempotency_token" \
      --query "CertificateArn" \
      --output text \
      --cli-connect-timeout 10 \
      --cli-read-timeout 60 \
      2>"$error_file"); then
      rm -f "$error_file"
      echo "$requested_arn"
      return 0
    else
      command_status=$?
    fi

    local reconciled_certificates
    reconciled_certificates=$(find_matching_certificates)
    local reconciled_count
    reconciled_count=$(echo "$reconciled_certificates" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')
    if [[ "$reconciled_count" -eq 1 ]]; then
      local reconciled_arn
      reconciled_arn=$(echo "$reconciled_certificates" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["arn"])')
      echo "WARNING: ACM certificate request response was inconclusive, but reconciliation found the single suitable certificate ${reconciled_arn}; reusing it." >&2
      rm -f "$error_file"
      echo "$reconciled_arn"
      return 0
    fi
    if [[ "$reconciled_count" -gt 1 ]]; then
      echo "ERROR: ACM certificate request reconciliation found ${reconciled_count} suitable exact-domain certificates for ${MCP_DOMAIN}; resolve the ambiguity before rerunning." >&2
      echo "$reconciled_certificates" >&2
      rm -f "$error_file"
      return 1
    fi

    local error_body
    error_body=$(sed -n '1,40p' "$error_file")
    if [[ "$attempt" -lt 3 ]]; then
      echo "WARNING: ACM certificate request attempt ${attempt}/3 failed; domain=${MCP_DOMAIN}; account=${AWS_ACCOUNT_ID}; region=${REGION}; status=${command_status}; response=${error_body:-empty}; no suitable certificate appeared during reconciliation; retrying with the same idempotency token in 2 seconds." >&2
      sleep 2
      attempt=$((attempt + 1))
      continue
    fi

    echo "ERROR: ACM certificate request failed after 3 reconciled attempts; domain=${MCP_DOMAIN}; account=${AWS_ACCOUNT_ID}; region=${REGION}; status=${command_status}; response=${error_body:-empty}. No suitable exact-domain certificate was found; verify ACM permissions and retry." >&2
    rm -f "$error_file"
    return 1
  done
}

echo "Looking for an active exact-domain ACM certificate for ${MCP_DOMAIN} in ${REGION}..."
MATCHING_CERTIFICATES=$(find_matching_certificates)
MATCHING_CERTIFICATE_COUNT=$(echo "$MATCHING_CERTIFICATES" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))')

if [[ "$MATCHING_CERTIFICATE_COUNT" -eq 0 ]]; then
  echo "No reusable certificate found; requesting one for ${MCP_DOMAIN}..."
  CERT_ARN=$(request_certificate_with_reconciliation)
  echo "Certificate requested: ${CERT_ARN}"
elif [[ "$MATCHING_CERTIFICATE_COUNT" -eq 1 ]]; then
  CERT_ARN=$(echo "$MATCHING_CERTIFICATES" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["arn"])')
  CERT_STATUS=$(echo "$MATCHING_CERTIFICATES" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["status"])')
  echo "Reusing ${CERT_STATUS} certificate: ${CERT_ARN}"
else
  echo "ERROR: Found ${MATCHING_CERTIFICATE_COUNT} reusable public DNS-validated certificates whose complete name set is exactly ${MCP_DOMAIN}." >&2
  echo "Resolve the duplicate certificates before rerunning; no certificate was requested and no DNS record was changed." >&2
  echo "$MATCHING_CERTIFICATES" | python3 -c '
import json
import sys
for certificate in json.load(sys.stdin):
    print("  {} / {} / {}: {}".format(certificate["status"], certificate["type"], certificate["validationMethod"], certificate["arn"]), file=sys.stderr)
'
  exit 1
fi

echo "Waiting for ACM to generate the DNS validation record..."
VALIDATION_JSON=""
for _ in $(seq 1 24); do
  VALIDATION_JSON=$(aws_api_request \
    "read ACM validation record for ${CERT_ARN}" \
    "$PROFILE" \
    "$REGION" \
    aws acm describe-certificate \
    --certificate-arn "$CERT_ARN" \
    --query "Certificate.DomainValidationOptions[0].ResourceRecord" \
    --output json)
  if [[ "$VALIDATION_JSON" != "null" ]]; then
    break
  fi
  sleep 5
done

if [[ -z "$VALIDATION_JSON" || "$VALIDATION_JSON" == "null" ]]; then
  echo "Timed out waiting for the ACM validation record for ${MCP_DOMAIN}." >&2
  echo "Certificate ARN: ${CERT_ARN}" >&2
  exit 1
fi

VALIDATION_NAME=$(echo "$VALIDATION_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['Name'].rstrip('.'))")
VALIDATION_VALUE=$(echo "$VALIDATION_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin)['Value'].rstrip('.'))")
echo "Validation CNAME: ${VALIDATION_NAME} -> ${VALIDATION_VALUE}"

EXISTING=$(cloudflare_read_all_dns_records \
  "read all DNS records for ACM validation hostname ${VALIDATION_NAME}" \
  "/zones/${CLOUDFLARE_ZONE_ID}/dns_records?name=${VALIDATION_NAME}&per_page=100")
EXISTING_RECORD=$(echo "$EXISTING" | cloudflare_classify_exact_cname \
  "$VALIDATION_NAME" \
  "$VALIDATION_VALUE" \
  "false" \
  "setup-mcp-domain.sh")
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
  echo "ACM validation CNAME already has the expected target and is DNS-only; reusing it."
  VALIDATION_RESULT='{"success":true}'
elif [[ "$EXISTING_STATE" == "drift" ]]; then
  EXISTING_CONTENT=$(echo "$EXISTING_RECORD" | python3 -c 'import json,sys; print(json.load(sys.stdin)["content"])')
  EXISTING_PROXIED=$(echo "$EXISTING_RECORD" | python3 -c 'import json,sys; print(str(json.load(sys.stdin)["proxied"]).lower())')
  echo "Reconciling ACM validation CNAME drift: current target=${EXISTING_CONTENT}, proxied=${EXISTING_PROXIED}; expected target=${VALIDATION_VALUE}, proxied=false."
  VALIDATION_RESULT=$(cloudflare_api_request \
    "update ACM validation CNAME ${VALIDATION_NAME}" \
    "PUT" \
    "/zones/${CLOUDFLARE_ZONE_ID}/dns_records/${EXISTING_ID}" \
    "$VALIDATION_PAYLOAD")
elif [[ "$EXISTING_STATE" == "absent" ]]; then
  VALIDATION_RESULT=$(cloudflare_api_request \
    "create ACM validation CNAME ${VALIDATION_NAME}" \
    "POST" \
    "/zones/${CLOUDFLARE_ZONE_ID}/dns_records" \
    "$VALIDATION_PAYLOAD" \
    "/zones/${CLOUDFLARE_ZONE_ID}/dns_records?name=${VALIDATION_NAME}&per_page=100")
else
  echo "ERROR: Unexpected ACM validation DNS reconciliation state '${EXISTING_STATE}' for ${VALIDATION_NAME}." >&2
  exit 1
fi

echo "$VALIDATION_RESULT" | python3 -c '
import json
import sys
response = json.load(sys.stdin)
if response.get("success") is not True:
    print(json.dumps(response.get("errors", response), indent=2), file=sys.stderr)
    raise SystemExit(1)
print("ACM validation CNAME is configured as DNS-only.")
'

echo "Waiting for ACM to issue the certificate..."
aws_api_request \
  "wait for ACM certificate ${CERT_ARN} validation" \
  "$PROFILE" \
  "$REGION" \
  aws acm wait certificate-validated \
  --certificate-arn "$CERT_ARN"

echo ""
echo "MCP certificate issued: ${CERT_ARN}"
echo "Keep the validation CNAME for ACM renewal."
echo "Store the ARN in cdk.context.local.json as mcpCertificateArn."
echo "Store the same ARN in GitHub Actions as CDK_MCP_CERTIFICATE_ARN before promotion."
