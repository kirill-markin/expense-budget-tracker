#!/usr/bin/env bash
# Create or update the Resend runtime API key in AWS Secrets Manager.

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

REGION="${AWS_REGION:-}"
PROFILE="${AWS_PROFILE:-}"
DOMAIN_NAME="${DOMAIN_NAME:-}"
SUBDOMAIN="${SUBDOMAIN:-mail}"
RESEND_SECRET_NAME="expense-tracker/resend-api-key"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN_NAME="$2"; shift 2 ;;
    --subdomain) SUBDOMAIN="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "${RESEND_API_KEY:-}" ]]; then
  echo "ERROR: RESEND_API_KEY must be set." >&2
  exit 1
fi

if [[ -z "$REGION" ]]; then
  echo "ERROR: AWS region is required. Pass --region or set AWS_REGION in .env." >&2
  exit 1
fi

if [[ -z "$PROFILE" ]]; then
  echo "ERROR: AWS profile is required. Pass --profile or set AWS_PROFILE in .env." >&2
  exit 1
fi

if [[ -z "$DOMAIN_NAME" ]]; then
  echo "ERROR: Domain is required. Pass --domain or set DOMAIN_NAME in .env." >&2
  exit 1
fi

if [[ -z "$SUBDOMAIN" ]]; then
  echo "ERROR: Subdomain is required. Pass --subdomain or set SUBDOMAIN in .env." >&2
  exit 1
fi

SENDER_EMAIL="no-reply@${SUBDOMAIN}.${DOMAIN_NAME}"
AWS_ARGS=(--region "$REGION" --profile "$PROFILE")
TEMP_DIR="$(mktemp -d)"
SECRET_FILE="$(mktemp "${TEMP_DIR}/resend.XXXXXX")"
chmod 600 "$SECRET_FILE"
printf '%s' "${RESEND_API_KEY}" > "$SECRET_FILE"

cleanup() {
  rm -rf "$TEMP_DIR"
}

trap cleanup EXIT

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

if [[ -n "$SECRET_ARN" && "$SECRET_ARN" != "None" ]]; then
  aws secretsmanager put-secret-value \
    --secret-id "$RESEND_SECRET_NAME" \
    --secret-string "file://${SECRET_FILE}" \
    "${AWS_ARGS[@]}" >/dev/null
else
  SECRET_ARN="$(aws secretsmanager create-secret \
    --name "$RESEND_SECRET_NAME" \
    --description "Resend API key for Expense Budget Tracker Cognito custom email sender" \
    --secret-string "file://${SECRET_FILE}" \
    "${AWS_ARGS[@]}" \
    --query ARN \
    --output text)"
fi

echo "Configured Resend API key secret in AWS Secrets Manager: ${SECRET_ARN}"
echo "Derived deploy sender email: ${SENDER_EMAIL}"
