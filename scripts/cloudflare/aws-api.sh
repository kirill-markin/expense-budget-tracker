#!/usr/bin/env bash

AWS_API_MAX_ATTEMPTS=3

aws_api_request() {
  local operation="$1"
  local profile="$2"
  local region="$3"
  shift 3
  if [[ -z "$profile" || -z "$region" ]]; then
    echo "ERROR: AWS ${operation} requires explicit non-empty profile and region values." >&2
    return 1
  fi

  local output_file
  local error_file
  output_file=$(mktemp)
  error_file=$(mktemp)
  local attempt=1

  while [[ "$attempt" -le "$AWS_API_MAX_ATTEMPTS" ]]; do
    local command_status
    if AWS_PAGER="" "$@" \
      --profile "$profile" \
      --region "$region" \
      --cli-connect-timeout 10 \
      --cli-read-timeout 60 \
      >"$output_file" \
      2>"$error_file"; then
      cat "$output_file"
      rm -f "$output_file" "$error_file"
      return 0
    else
      command_status=$?
    fi

    local response_body
    response_body=$(sed -n '1,40p' "$error_file")
    if [[ "$attempt" -lt "$AWS_API_MAX_ATTEMPTS" ]]; then
      echo "WARNING: AWS ${operation} attempt ${attempt}/${AWS_API_MAX_ATTEMPTS} failed; profile=${profile}; region=${region}; status=${command_status}; response=${response_body:-empty}; retrying in 2 seconds." >&2
      sleep 2
      attempt=$((attempt + 1))
      continue
    fi

    echo "ERROR: AWS ${operation} failed after ${AWS_API_MAX_ATTEMPTS} attempts; profile=${profile}; region=${region}; status=${command_status}; response=${response_body:-empty}. Verify credentials, permissions, account, region, and the requested resource." >&2
    rm -f "$output_file" "$error_file"
    return 1
  done
}
