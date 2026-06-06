#!/usr/bin/env bash
# Create or reuse a Resend sending domain, sync its DNS records to Cloudflare,
# and verify the domain when Resend still reports it as unverified.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ROOT_ENV_FILE="${ROOT_DIR}/.env"
CLOUDFLARE_ENV_FILE="${ROOT_DIR}/scripts/cloudflare/.env"

if [[ -f "$ROOT_ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ROOT_ENV_FILE"
  set +a
fi

if [[ -f "$CLOUDFLARE_ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$CLOUDFLARE_ENV_FILE"
  set +a
fi

DOMAIN="${DOMAIN_NAME:-}"
SUBDOMAIN="mail"
RESEND_REGION="eu-west-1"
RESEND_API_BASE="https://api.resend.com"
DRY_RUN="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --subdomain) SUBDOMAIN="$2"; shift 2 ;;
    --region) RESEND_REGION="$2"; shift 2 ;;
    --resend-region) RESEND_REGION="$2"; shift 2 ;;
    --dry-run) DRY_RUN="true"; shift 1 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$DOMAIN" ]]; then
  echo "ERROR: Domain is required. Pass --domain or set DOMAIN_NAME in .env." >&2
  exit 1
fi

if [[ -z "${RESEND_ADMIN_API_KEY:-}" ]]; then
  echo "ERROR: RESEND_ADMIN_API_KEY must be set." >&2
  exit 1
fi

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "ERROR: CLOUDFLARE_API_TOKEN must be set." >&2
  exit 1
fi

if [[ -z "${CLOUDFLARE_ZONE_ID:-}" ]]; then
  echo "ERROR: CLOUDFLARE_ZONE_ID must be set." >&2
  exit 1
fi

FULL_DOMAIN="${SUBDOMAIN}.${DOMAIN}"
TEMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TEMP_DIR"
}

trap cleanup EXIT

resend_request() {
  local method="$1"
  local path="$2"
  local body="$3"
  local error_file
  local output_file
  local status

  if [[ "$DRY_RUN" == "true" && "$method" != "GET" ]]; then
    echo "{\"dryRun\":true,\"method\":\"${method}\",\"path\":\"${path}\"}"
    return
  fi

  error_file="$(mktemp "${TEMP_DIR}/resend-curl-error.XXXXXX")"
  output_file="$(mktemp)"
  if [[ -n "$body" ]]; then
    if ! status="$(curl -sS -o "$output_file" -w "%{http_code}" \
      -X "$method" \
      "${RESEND_API_BASE}${path}" \
      -H "Authorization: Bearer ${RESEND_ADMIN_API_KEY}" \
      -H "Content-Type: application/json" \
      --data "$body" 2>"$error_file")"; then
      echo "ERROR: Resend ${method} ${path} request failed before receiving an HTTP response." >&2
      cat "$error_file" >&2
      rm -f "$error_file" "$output_file"
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
      rm -f "$error_file" "$output_file"
      exit 1
    fi
  fi
  rm -f "$error_file"

  if [[ "$status" != 2* ]]; then
    echo "ERROR: Resend ${method} ${path} failed with HTTP ${status}." >&2
    cat "$output_file" >&2
    rm -f "$output_file"
    exit 1
  fi

  cat "$output_file"
  rm -f "$output_file"
}

resolve_full_record_name() {
  local record_name="$1"
  python3 - "$record_name" "$FULL_DOMAIN" <<'PY'
import sys

record_name = sys.argv[1].rstrip(".")
full_domain = sys.argv[2].rstrip(".")

record_labels = [label for label in record_name.split(".") if label]
domain_labels = [label for label in full_domain.split(".") if label]

max_overlap = min(len(record_labels), len(domain_labels))
overlap = 0
for candidate in range(max_overlap, 0, -1):
    if record_labels[-candidate:] == domain_labels[:candidate]:
        overlap = candidate
        break

merged = record_labels + domain_labels[overlap:]
print(".".join(merged))
PY
}

get_domain_id() {
  local list_response

  list_response="$(resend_request "GET" "/domains" "")"
  python3 - "$list_response" "$FULL_DOMAIN" <<'PY'
import json
import sys

response = json.loads(sys.argv[1])
target_name = sys.argv[2]
for item in response.get("data", []):
    if item.get("name") == target_name:
        print(item.get("id", ""))
        break
PY
}

create_domain() {
  local payload

  payload="$(python3 - "$FULL_DOMAIN" "$RESEND_REGION" <<'PY'
import json
import sys

print(json.dumps({
    "name": sys.argv[1],
    "region": sys.argv[2],
    "capabilities": {
        "sending": "enabled",
        "receiving": "disabled",
    },
}))
PY
)"

  resend_request "POST" "/domains" "$payload"
}

get_domain() {
  local domain_id="$1"
  resend_request "GET" "/domains/${domain_id}" ""
}

verify_domain() {
  local domain_id="$1"
  resend_request "POST" "/domains/${domain_id}/verify" ""
}

get_domain_status() {
  local domain_json="$1"

  python3 - "$domain_json" <<'PY'
import json
import sys

response = json.loads(sys.argv[1])
print(response.get("status", "unknown"))
PY
}

validate_cloudflare_response() {
  local output_file="$1"

  python3 - "$output_file" <<'PY'
import json
import pathlib
import sys

response_path = pathlib.Path(sys.argv[1])
body = response_path.read_text(encoding="utf-8")
try:
    response = json.loads(body)
except json.JSONDecodeError as error:
    print(f"ERROR: Cloudflare response was not valid JSON: {error}", file=sys.stderr)
    print(body, file=sys.stderr)
    raise SystemExit(1)

if response.get("success") is True:
    raise SystemExit(0)

print("ERROR: Cloudflare API success was not true.", file=sys.stderr)
errors = response.get("errors")
if isinstance(errors, list) and errors:
    for error in errors:
        if isinstance(error, dict):
            code = error.get("code", "unknown")
            message = error.get("message", "unknown")
            print(f"- code={code} message={message}", file=sys.stderr)
        else:
            print(f"- {error}", file=sys.stderr)
else:
    print(body, file=sys.stderr)
raise SystemExit(1)
PY
}

cloudflare_request_to_file() {
  local method="$1"
  local path="$2"
  local body="$3"
  local error_file
  local output_file="$4"
  local status

  error_file="$(mktemp "${TEMP_DIR}/cloudflare-curl-error.XXXXXX")"
  if [[ -n "$body" ]]; then
    if ! status="$(curl -sS -o "$output_file" -w "%{http_code}" \
      -X "$method" \
      "https://api.cloudflare.com/client/v4${path}" \
      -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
      -H "Content-Type: application/json" \
      --data "$body" 2>"$error_file")"; then
      echo "ERROR: Cloudflare ${method} ${path} request failed before receiving an HTTP response." >&2
      cat "$error_file" >&2
      rm -f "$error_file"
      exit 1
    fi
  else
    if ! status="$(curl -sS -o "$output_file" -w "%{http_code}" \
      -X "$method" \
      "https://api.cloudflare.com/client/v4${path}" \
      -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
      -H "Content-Type: application/json" 2>"$error_file")"; then
      echo "ERROR: Cloudflare ${method} ${path} request failed before receiving an HTTP response." >&2
      cat "$error_file" >&2
      rm -f "$error_file"
      exit 1
    fi
  fi
  rm -f "$error_file"

  if [[ "$status" != 2* ]]; then
    echo "ERROR: Cloudflare ${method} ${path} failed with HTTP ${status}." >&2
    cat "$output_file" >&2
    exit 1
  fi

  validate_cloudflare_response "$output_file"
}

verify_cloudflare_zone_matches_domain() {
  local response_file
  local zone_name

  response_file="$(mktemp "${TEMP_DIR}/cloudflare-zone.XXXXXX")"
  cloudflare_request_to_file \
    "GET" \
    "/zones/${CLOUDFLARE_ZONE_ID}" \
    "" \
    "$response_file"

  zone_name="$(python3 - "$response_file" <<'PY'
import json
import pathlib
import sys

response = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
zone_name = response.get("result", {}).get("name", "")
if not isinstance(zone_name, str) or zone_name == "":
    raise SystemExit("Cloudflare zone response did not include result.name")
print(zone_name)
PY
)"

  if [[ "$zone_name" != "$DOMAIN" ]]; then
    echo "ERROR: CLOUDFLARE_ZONE_ID does not match requested domain." >&2
    echo "Requested domain: ${DOMAIN}" >&2
    echo "Cloudflare zone ID: ${CLOUDFLARE_ZONE_ID}" >&2
    echo "Cloudflare zone name: ${zone_name}" >&2
    exit 1
  fi
}

upsert_record() {
  local type="$1"
  local fqdn="$2"
  local content="$3"
  local priority="$4"
  local response_file
  local upsert_response_file
  local record_id
  local payload

  response_file="$(mktemp "${TEMP_DIR}/cloudflare-list.XXXXXX")"
  cloudflare_request_to_file \
    "GET" \
    "/zones/${CLOUDFLARE_ZONE_ID}/dns_records?type=${type}&name=${fqdn}" \
    "" \
    "$response_file"
  record_id="$(python3 - "$response_file" "$type" "$fqdn" "$content" <<'PY'
import json
import pathlib
import sys

data = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")).get("result", [])
record_type = sys.argv[2]
record_name = sys.argv[3]
target_content = sys.argv[4].rstrip(".")

if record_type in ("TXT", "MX"):
    matching_record_id = ""
    conflicting_records = []
    for record in data:
        content = str(record.get("content", "")).rstrip(".")
        if content == target_content:
            if matching_record_id == "":
                matching_record_id = str(record.get("id", ""))
        else:
            conflicting_records.append(content)
    if conflicting_records:
        print(
            f"ERROR: Existing {record_type} record(s) for {record_name} have conflicting content.",
            file=sys.stderr,
        )
        print(f"Expected content: {target_content}", file=sys.stderr)
        for conflicting_content in conflicting_records:
            print(f"Existing content: {conflicting_content}", file=sys.stderr)
        raise SystemExit(1)
    if matching_record_id != "":
        print(matching_record_id)
        raise SystemExit(0)
    print("")
    raise SystemExit(0)

print(data[0]["id"] if data else "")
PY
)"

  payload="$(python3 - "$type" "$fqdn" "$content" "$priority" <<'PY'
import json
import sys

record_type, name, content, priority = sys.argv[1:5]
payload = {
    "type": record_type,
    "name": name,
    "content": content.rstrip("."),
    "ttl": 1,
}
if record_type == "CNAME":
    payload["proxied"] = False
if record_type == "MX":
    payload["priority"] = int(priority)
print(json.dumps(payload))
PY
)"

  if [[ "$DRY_RUN" == "true" ]]; then
    echo "DRY RUN upsert ${type} ${fqdn} -> ${content}"
    return
  fi

  upsert_response_file="$(mktemp "${TEMP_DIR}/cloudflare-upsert.XXXXXX")"
  if [[ -n "$record_id" ]]; then
    cloudflare_request_to_file \
      "PUT" \
      "/zones/${CLOUDFLARE_ZONE_ID}/dns_records/${record_id}" \
      "$payload" \
      "$upsert_response_file"
    echo "Updated DNS record: ${fqdn} (${type})"
    return
  fi

  cloudflare_request_to_file \
    "POST" \
    "/zones/${CLOUDFLARE_ZONE_ID}/dns_records" \
    "$payload" \
    "$upsert_response_file"
  echo "Created DNS record: ${fqdn} (${type})"
}

apply_domain_records() {
  local domain_json="$1"

  python3 - "$domain_json" <<'PY' | while IFS=$'\t' read -r type name content priority; do
import json
import sys

domain = json.loads(sys.argv[1])
for record in domain.get("records", []):
    priority = record.get("priority")
    print(
        f"{record.get('type', '')}\t{record.get('name', '')}\t{record.get('value', '')}\t"
        f"{'' if priority is None else priority}"
    )
PY
    if [[ -z "$type" || -z "$name" || -z "$content" ]]; then
      continue
    fi

    fqdn="$(resolve_full_record_name "$name")"
    upsert_record "$type" "$fqdn" "$content" "$priority"
  done
}

verify_cloudflare_zone_matches_domain

DOMAIN_ID="$(get_domain_id)"

if [[ -z "$DOMAIN_ID" ]]; then
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "DRY RUN create Resend domain: ${FULL_DOMAIN}"
    exit 0
  fi

  CREATE_RESPONSE="$(create_domain)"
  DOMAIN_ID="$(python3 - "$CREATE_RESPONSE" <<'PY'
import json
import sys

response = json.loads(sys.argv[1])
print(response.get("id", ""))
PY
)"

  if [[ -z "$DOMAIN_ID" ]]; then
    echo "ERROR: Failed to create Resend domain for ${FULL_DOMAIN}." >&2
    echo "$CREATE_RESPONSE" >&2
    exit 1
  fi
fi

DOMAIN_RESPONSE="$(get_domain "$DOMAIN_ID")"
apply_domain_records "$DOMAIN_RESPONSE"

DOMAIN_RESPONSE="$(get_domain "$DOMAIN_ID")"
DOMAIN_STATUS="$(get_domain_status "$DOMAIN_RESPONSE")"

if [[ "$DOMAIN_STATUS" == "verified" ]]; then
  echo "Resend domain already verified: ${FULL_DOMAIN}"
  exit 0
fi

if [[ "$DRY_RUN" == "true" ]]; then
  echo "DRY RUN would request Resend verification for ${FULL_DOMAIN}. Current status: ${DOMAIN_STATUS}"
  exit 0
fi

verify_domain "$DOMAIN_ID" >/dev/null

for _ in 1 2 3 4 5; do
  sleep 5
  DOMAIN_RESPONSE="$(get_domain "$DOMAIN_ID")"
  DOMAIN_STATUS="$(get_domain_status "$DOMAIN_RESPONSE")"

  if [[ "$DOMAIN_STATUS" == "verified" ]]; then
    echo "Verified Resend domain: ${FULL_DOMAIN}"
    exit 0
  fi
done

echo "ERROR: Resend domain ${FULL_DOMAIN} is not verified after DNS setup." >&2
echo "Current Resend status: ${DOMAIN_STATUS}" >&2
echo "DNS records are configured, but propagation can take time." >&2
echo "Wait for DNS propagation, then rerun this script before creating the runtime key." >&2
exit 1
