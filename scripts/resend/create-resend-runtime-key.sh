#!/usr/bin/env bash
# Create a domain-scoped send-only Resend API key and store it in AWS Secrets Manager.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ROOT_ENV_FILE="${ROOT_DIR}/.env"

if [[ -f "$ROOT_ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ROOT_ENV_FILE"
  set +a
fi

DOMAIN="${DOMAIN_NAME:-}"
SUBDOMAIN="mail"
REGION="${AWS_REGION:-}"
PROFILE="${AWS_PROFILE:-}"
RESEND_API_BASE="https://api.resend.com"
RESEND_SECRET_NAME="expense-tracker/resend-api-key"
ROTATE_SECRET="false"
PREVIOUS_API_KEY_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --subdomain) SUBDOMAIN="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    --rotate-secret) ROTATE_SECRET="true"; shift 1 ;;
    --previous-api-key-id) PREVIOUS_API_KEY_ID="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$REGION" ]]; then
  echo "ERROR: AWS region is required. Pass --region or set AWS_REGION in .env." >&2
  exit 1
fi

if [[ -z "$DOMAIN" ]]; then
  echo "ERROR: Domain is required. Pass --domain or set DOMAIN_NAME in .env." >&2
  exit 1
fi

if [[ -z "$PROFILE" ]]; then
  echo "ERROR: AWS profile is required. Pass --profile or set AWS_PROFILE in .env." >&2
  exit 1
fi

if [[ -z "${RESEND_ADMIN_API_KEY:-}" ]]; then
  echo "ERROR: RESEND_ADMIN_API_KEY must be set." >&2
  exit 1
fi

if [[ -n "$PREVIOUS_API_KEY_ID" && "$ROTATE_SECRET" != "true" ]]; then
  echo "ERROR: --previous-api-key-id is only valid with --rotate-secret." >&2
  exit 1
fi

AWS_ARGS=(--region "$REGION" --profile "$PROFILE")
FULL_DOMAIN="${SUBDOMAIN}.${DOMAIN}"
SENDER_EMAIL="no-reply@${FULL_DOMAIN}"
TEMP_DIR="$(mktemp -d)"
DOMAIN_RESPONSE_FILE="$(mktemp "${TEMP_DIR}/domain.XXXXXX")"
API_KEY_RESPONSE_FILE="$(mktemp "${TEMP_DIR}/api-key.XXXXXX")"
SECRET_FILE="$(mktemp "${TEMP_DIR}/resend.XXXXXX")"
API_KEY_ID=""
chmod 600 "$SECRET_FILE"

cleanup() {
  rm -rf "$TEMP_DIR"
}

trap cleanup EXIT

resend_request_to_file() {
  local method="$1"
  local path="$2"
  local body="$3"
  local error_file
  local output_file="$4"
  local status

  error_file="$(mktemp "${TEMP_DIR}/resend-curl-error.XXXXXX")"
  if [[ -n "$body" ]]; then
    if ! status="$(curl -sS -o "$output_file" -w "%{http_code}" \
      -X "$method" \
      "${RESEND_API_BASE}${path}" \
      -H "Authorization: Bearer ${RESEND_ADMIN_API_KEY}" \
      -H "Content-Type: application/json" \
      --data "$body" 2>"$error_file")"; then
      echo "ERROR: Resend ${method} ${path} request failed before receiving an HTTP response." >&2
      cat "$error_file" >&2
      rm -f "$error_file"
      exit 1
    fi
  else
    if ! status="$(curl -sS -o "$output_file" -w "%{http_code}" \
      -X "$method" \
      "${RESEND_API_BASE}${path}" \
      -H "Authorization: Bearer ${RESEND_ADMIN_API_KEY}" \
      -H "Content-Type: application/json" 2>"$error_file")"; then
      echo "ERROR: Resend ${method} ${path} request failed before receiving an HTTP response." >&2
      cat "$error_file" >&2
      rm -f "$error_file"
      exit 1
    fi
  fi
  rm -f "$error_file"

  if [[ "$status" != 2* ]]; then
    echo "ERROR: Resend ${method} ${path} failed with HTTP ${status}." >&2
    cat "$output_file" >&2
    exit 1
  fi
}

delete_resend_api_key() {
  local api_key_id="$1"
  local error_file
  local output_file
  local status

  error_file="$(mktemp "${TEMP_DIR}/resend-delete-curl-error.XXXXXX")"
  output_file="$(mktemp "${TEMP_DIR}/resend-delete.XXXXXX")"

  if ! status="$(curl -sS -o "$output_file" -w "%{http_code}" \
    -X "DELETE" \
    "${RESEND_API_BASE}/api-keys/${api_key_id}" \
    -H "Authorization: Bearer ${RESEND_ADMIN_API_KEY}" \
    -H "Content-Type: application/json" 2>"$error_file")"; then
    echo "WARNING: Resend DELETE /api-keys/${api_key_id} failed before receiving an HTTP response." >&2
    cat "$error_file" >&2
    rm -f "$error_file" "$output_file"
    return 1
  fi

  rm -f "$error_file"

  if [[ "$status" != 2* ]]; then
    echo "WARNING: Resend DELETE /api-keys/${api_key_id} failed with HTTP ${status}." >&2
    cat "$output_file" >&2
    rm -f "$output_file"
    return 1
  fi

  rm -f "$output_file"
}

write_secret_to_aws() {
  local error_file

  error_file="$(mktemp "${TEMP_DIR}/aws-secretsmanager-error.XXXXXX")"

  if [[ -n "$SECRET_ARN" && "$SECRET_ARN" != "None" ]]; then
    if ! aws secretsmanager put-secret-value \
      --secret-id "$RESEND_SECRET_NAME" \
      --secret-string "file://${SECRET_FILE}" \
      "${AWS_ARGS[@]}" > /dev/null 2>"$error_file"; then
      echo "ERROR: Failed to update AWS Secrets Manager secret ${RESEND_SECRET_NAME}." >&2
      cat "$error_file" >&2
      rm -f "$error_file"
      return 1
    fi
  else
    if ! SECRET_ARN="$(aws secretsmanager create-secret \
      --name "$RESEND_SECRET_NAME" \
      --description "Resend API key for Expense Budget Tracker Cognito custom email sender" \
      --secret-string "file://${SECRET_FILE}" \
      "${AWS_ARGS[@]}" \
      --query ARN \
      --output text 2>"$error_file")"; then
      echo "ERROR: Failed to create AWS Secrets Manager secret ${RESEND_SECRET_NAME}." >&2
      cat "$error_file" >&2
      rm -f "$error_file"
      return 1
    fi
  fi

  rm -f "$error_file"
}

read -r AWS_ACCOUNT_ID AWS_CALLER_ARN < <(aws sts get-caller-identity \
  "${AWS_ARGS[@]}" \
  --query '[Account,Arn]' \
  --output text)
echo "Using AWS account ${AWS_ACCOUNT_ID} with profile ${PROFILE}: ${AWS_CALLER_ARN}"

SECRET_ARN="$(aws secretsmanager describe-secret \
  --secret-id "$RESEND_SECRET_NAME" \
  "${AWS_ARGS[@]}" \
  --query ARN \
  --output text 2>/dev/null || true)"

if [[ -n "$SECRET_ARN" && "$SECRET_ARN" != "None" && "$ROTATE_SECRET" == "true" && -z "$PREVIOUS_API_KEY_ID" ]]; then
  echo "ERROR: --rotate-secret requires --previous-api-key-id when the AWS secret already exists." >&2
  echo "The current AWS secret value contains only the Resend token, not its non-secret key id." >&2
  echo "Find the active runtime key id in the Resend dashboard or API, then rerun:" >&2
  echo "  bash scripts/resend/create-resend-runtime-key.sh --rotate-secret --previous-api-key-id <resend_key_id> --domain ${DOMAIN} --subdomain ${SUBDOMAIN} --region ${REGION} --profile ${PROFILE}" >&2
  exit 1
fi

resend_request_to_file "GET" "/domains" "" "$DOMAIN_RESPONSE_FILE"

DOMAIN_ID="$(python3 - "$DOMAIN_RESPONSE_FILE" "$FULL_DOMAIN" <<'PY'
import json
import pathlib
import sys

response = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
target_name = sys.argv[2]
for item in response.get("data", []):
    if item.get("name") == target_name:
        print(item.get("id", ""))
        break
PY
)"

if [[ -z "$DOMAIN_ID" ]]; then
  echo "ERROR: Resend domain ${FULL_DOMAIN} was not found. Run scripts/resend/setup-resend-domain.sh first." >&2
  exit 1
fi

resend_request_to_file "GET" "/domains/${DOMAIN_ID}" "" "$DOMAIN_RESPONSE_FILE"
DOMAIN_STATUS="$(python3 - "$DOMAIN_RESPONSE_FILE" <<'PY'
import json
import pathlib
import sys

response = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
print(response.get("status", "unknown"))
PY
)"

if [[ "$DOMAIN_STATUS" != "verified" ]]; then
  echo "ERROR: Resend domain ${FULL_DOMAIN} is not verified. Current status: ${DOMAIN_STATUS}." >&2
  exit 1
fi

if [[ -n "$SECRET_ARN" && "$SECRET_ARN" != "None" && "$ROTATE_SECRET" != "true" ]]; then
  echo "Resend API key secret already exists in AWS Secrets Manager: ${SECRET_ARN}"
  echo "Verified Resend domain: ${FULL_DOMAIN}"
  echo "Derived deploy sender email: ${SENDER_EMAIL}"
  echo "Use --rotate-secret only when you intentionally want to create a new Resend key and replace the secret value."
  exit 0
fi

API_KEY_PAYLOAD="$(python3 - "$DOMAIN_ID" "$FULL_DOMAIN" <<'PY'
import json
import sys

domain_id = sys.argv[1]
full_domain = sys.argv[2]
print(json.dumps({
    "name": f"expense-budget-tracker {full_domain}",
    "permission": "sending_access",
    "domain_id": domain_id,
}))
PY
)"

resend_request_to_file "POST" "/api-keys" "$API_KEY_PAYLOAD" "$API_KEY_RESPONSE_FILE"

API_KEY_ID="$(python3 - "$API_KEY_RESPONSE_FILE" <<'PY'
import json
import pathlib
import sys

response_path = pathlib.Path(sys.argv[1])
response = json.loads(response_path.read_text(encoding="utf-8"))
api_key_id = response.get("id")
if not isinstance(api_key_id, str) or api_key_id == "":
    raise SystemExit("Resend create API key response did not include id")
print(api_key_id)
PY
)"

if ! python3 - "$API_KEY_RESPONSE_FILE" "$SECRET_FILE" <<'PY'
import json
import pathlib
import sys

response_path = pathlib.Path(sys.argv[1])
secret_path = pathlib.Path(sys.argv[2])
response = json.loads(response_path.read_text(encoding="utf-8"))
token = response.get("token")
if not isinstance(token, str) or token == "":
    raise SystemExit("Resend create API key response did not include token")
secret_path.write_text(token, encoding="utf-8")
PY
then
  echo "ERROR: Failed to extract the Resend runtime key token from create response." >&2
  echo "Attempting to delete created Resend API key ${API_KEY_ID}." >&2
  if delete_resend_api_key "$API_KEY_ID"; then
    echo "Deleted created Resend API key ${API_KEY_ID}."
  else
    echo "WARNING: Created Resend API key ${API_KEY_ID} may still be active." >&2
    echo "Delete it manually in Resend before rerunning this script." >&2
  fi
  exit 1
fi

if ! write_secret_to_aws; then
  echo "Attempting to delete created Resend API key ${API_KEY_ID} because AWS secret write failed." >&2
  if delete_resend_api_key "$API_KEY_ID"; then
    echo "Deleted created Resend API key ${API_KEY_ID}."
  else
    echo "WARNING: Created Resend API key ${API_KEY_ID} may still be active." >&2
    echo "Delete it manually in Resend before rerunning this script." >&2
  fi
  exit 1
fi

if [[ -n "$PREVIOUS_API_KEY_ID" ]]; then
  echo "Deleting previous Resend API key ${PREVIOUS_API_KEY_ID} after AWS secret update."
  if delete_resend_api_key "$PREVIOUS_API_KEY_ID"; then
    echo "Deleted previous Resend API key ${PREVIOUS_API_KEY_ID}."
  else
    echo "ERROR: AWS Secrets Manager now points to the new key, but the previous Resend API key ${PREVIOUS_API_KEY_ID} may still be active." >&2
    echo "New Resend API key id: ${API_KEY_ID}" >&2
    echo "AWS Secrets Manager secret: ${RESEND_SECRET_NAME} (${SECRET_ARN})" >&2
    echo "Delete the previous key manually in Resend before treating rotation as complete." >&2
    exit 1
  fi
fi

echo "Created Resend send-only API key: ${API_KEY_ID}"
echo "Configured Resend API key secret in AWS Secrets Manager: ${SECRET_ARN}"
echo "Derived deploy sender email: ${SENDER_EMAIL}"
