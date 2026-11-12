#!/usr/bin/env bash
# Invoke the private admin-reader Lambda with one JSON event and print its JSON
# response to stdout. See docs/admin-reader.md for the events.
#
# Usage:
#   scripts/admin-read.sh --profile <profile> --region <region> '<json event>'
#
# AWS_PROFILE and AWS_REGION may replace the flags. Neither has a default: the
# profile and region must name the production account explicitly.

set -euo pipefail

STACK_NAME="ExpenseBudgetTracker"
USAGE="Usage: scripts/admin-read.sh --profile <profile> --region <region> '<json event>'"

PROFILE="${AWS_PROFILE:-}"
REGION="${AWS_REGION:-}"
EVENT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile)
      [[ $# -ge 2 ]] || { echo "ERROR: --profile needs a value. $USAGE" >&2; exit 2; }
      PROFILE="$2"
      shift 2
      ;;
    --region)
      [[ $# -ge 2 ]] || { echo "ERROR: --region needs a value. $USAGE" >&2; exit 2; }
      REGION="$2"
      shift 2
      ;;
    -*)
      echo "ERROR: unknown option $1. $USAGE" >&2
      exit 2
      ;;
    *)
      [[ -z "$EVENT" ]] || { echo "ERROR: pass exactly one JSON event. $USAGE" >&2; exit 2; }
      EVENT="$1"
      shift
      ;;
  esac
done

if [[ -z "$EVENT" ]]; then
  echo "ERROR: missing JSON event. $USAGE" >&2
  exit 2
fi
if [[ -z "$PROFILE" ]]; then
  echo "ERROR: no AWS profile; pass --profile or set AWS_PROFILE to the production account's profile. $USAGE" >&2
  exit 2
fi
if [[ -z "$REGION" ]]; then
  echo "ERROR: no AWS region; pass --region or set AWS_REGION to the stack's region from infra/aws/cdk.context.local.json. $USAGE" >&2
  exit 2
fi

AWS_FLAGS=(--profile "$PROFILE" --region "$REGION")

FUNCTION_NAME=$(aws cloudformation describe-stacks "${AWS_FLAGS[@]}" \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='AdminReaderFunctionName'].OutputValue" \
  --output text)
if [[ -z "$FUNCTION_NAME" || "$FUNCTION_NAME" == "None" ]]; then
  echo "ERROR: stack $STACK_NAME in $REGION (profile $PROFILE) has no AdminReaderFunctionName output; deploy the admin reader first." >&2
  exit 1
fi

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

FUNCTION_ERROR=$(aws lambda invoke "${AWS_FLAGS[@]}" \
  --function-name "$FUNCTION_NAME" \
  --cli-binary-format raw-in-base64-out \
  --payload "$EVENT" \
  --query FunctionError \
  --output text \
  "$WORK_DIR/response.json")

if [[ "$FUNCTION_ERROR" != "None" ]]; then
  echo "ERROR: admin reader $FUNCTION_NAME failed ($FUNCTION_ERROR):" >&2
  cat "$WORK_DIR/response.json" >&2
  echo >&2
  exit 1
fi

cat "$WORK_DIR/response.json"
echo
