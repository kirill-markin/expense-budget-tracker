#!/usr/bin/env bash

if [[ $- == *a* ]]; then
  set +a
  _CLOUDFLARE_ALLEXPORT_WAS_ENABLED=true
else
  _CLOUDFLARE_ALLEXPORT_WAS_ENABLED=false
fi
CLOUDFLARE_API_TOKEN_LOCAL="${CLOUDFLARE_API_TOKEN:-}"
unset CLOUDFLARE_API_TOKEN
CLOUDFLARE_API_BASE_URL="https://api.cloudflare.com/client/v4"
CLOUDFLARE_API_MAX_ATTEMPTS=3
CLOUDFLARE_API_UNKNOWN_OUTCOME_STATUS=75
CLOUDFLARE_DNS_RECONCILIATION_ATTEMPTS=5
CLOUDFLARE_DNS_RECONCILIATION_MAX_PAGES=20
CLOUDFLARE_ORIGIN_CA_RECONCILIATION_ATTEMPTS=5
CLOUDFLARE_ORIGIN_CA_RECONCILIATION_MAX_PAGES=20
CLOUDFLARE_CURL_CONFIG_FILE=""
export -n \
  CLOUDFLARE_API_TOKEN_LOCAL \
  CLOUDFLARE_API_BASE_URL \
  CLOUDFLARE_API_MAX_ATTEMPTS \
  CLOUDFLARE_API_UNKNOWN_OUTCOME_STATUS \
  CLOUDFLARE_DNS_RECONCILIATION_ATTEMPTS \
  CLOUDFLARE_DNS_RECONCILIATION_MAX_PAGES \
  CLOUDFLARE_ORIGIN_CA_RECONCILIATION_ATTEMPTS \
  CLOUDFLARE_ORIGIN_CA_RECONCILIATION_MAX_PAGES \
  CLOUDFLARE_CURL_CONFIG_FILE
if [[ "$_CLOUDFLARE_ALLEXPORT_WAS_ENABLED" == "true" ]]; then
  set -a
fi
unset _CLOUDFLARE_ALLEXPORT_WAS_ENABLED

cloudflare_cleanup_curl_config() {
  if [[ -n "${CLOUDFLARE_CURL_CONFIG_FILE}" ]]; then
    rm -f -- "${CLOUDFLARE_CURL_CONFIG_FILE}"
    CLOUDFLARE_CURL_CONFIG_FILE=""
    export -n CLOUDFLARE_CURL_CONFIG_FILE
  fi
  unset CLOUDFLARE_API_TOKEN
  unset CLOUDFLARE_API_TOKEN_LOCAL
}

cloudflare_require_api_token() {
  if [[ -z "${CLOUDFLARE_API_TOKEN_LOCAL:-}" ]]; then
    echo "ERROR: CLOUDFLARE_API_TOKEN must be set before sourcing cloudflare-api.sh." >&2
    return 1
  fi
}

cloudflare_prepare_curl_config() {
  unset CLOUDFLARE_API_TOKEN
  export -n CLOUDFLARE_API_TOKEN_LOCAL CLOUDFLARE_CURL_CONFIG_FILE
  if [[ -n "${CLOUDFLARE_CURL_CONFIG_FILE}" ]]; then
    return 0
  fi
  if ! cloudflare_require_api_token; then
    return 1
  fi
  if [[ ! "${CLOUDFLARE_API_TOKEN_LOCAL}" =~ ^[A-Za-z0-9._~-]+$ ]]; then
    echo "ERROR: CLOUDFLARE_API_TOKEN contains characters that cannot be stored safely in a curl config file." >&2
    return 1
  fi

  local previous_umask
  previous_umask=$(umask)
  umask 077
  CLOUDFLARE_CURL_CONFIG_FILE=$(mktemp)
  export -n CLOUDFLARE_CURL_CONFIG_FILE
  umask "${previous_umask}"
  trap 'cloudflare_cleanup_curl_config' EXIT
  trap 'cloudflare_cleanup_curl_config; exit 129' HUP
  trap 'cloudflare_cleanup_curl_config; exit 130' INT
  trap 'cloudflare_cleanup_curl_config; exit 143' TERM

  if ! chmod 600 "${CLOUDFLARE_CURL_CONFIG_FILE}"; then
    echo "ERROR: Could not restrict permissions on the temporary Cloudflare curl config." >&2
    cloudflare_cleanup_curl_config
    return 1
  fi
  if ! printf 'header = "Authorization: Bearer %s"\n' "${CLOUDFLARE_API_TOKEN_LOCAL}" >"${CLOUDFLARE_CURL_CONFIG_FILE}"; then
    echo "ERROR: Could not write the temporary Cloudflare curl config." >&2
    cloudflare_cleanup_curl_config
    return 1
  fi
}

cloudflare_redact_credentials() {
  local value="$1"
  if [[ -n "${CLOUDFLARE_API_TOKEN_LOCAL:-}" ]]; then
    value="${value//"${CLOUDFLARE_API_TOKEN_LOCAL}"/[REDACTED]}"
  fi
  printf '%s' "$value"
}

cloudflare_response_state() {
  local response_file="$1"
  python3 - "$response_file" <<'PY'
import json
import pathlib
import sys

response_path = pathlib.Path(sys.argv[1])
try:
    response = json.loads(response_path.read_text(encoding="utf-8"))
except (OSError, UnicodeDecodeError, json.JSONDecodeError):
    print("invalid")
    raise SystemExit(0)

if response.get("success") is True:
    print("success")
    raise SystemExit(0)

errors = response.get("errors", [])
if any("not found" in str(error.get("message", "")).lower() for error in errors if isinstance(error, dict)):
    print("not_found")
    raise SystemExit(0)

print("error")
PY
}

cloudflare_error_body() {
  local response_file="$1"
  python3 - "$response_file" <<'PY'
import pathlib
import sys

response_path = pathlib.Path(sys.argv[1])
try:
    body = response_path.read_text(encoding="utf-8")
except (OSError, UnicodeDecodeError) as error:
    body = f"<unreadable response body: {error}>"
print(body[:2000] if body else "<empty response body>")
PY
}

cloudflare_is_origin_certificate_payload() {
  local payload="$1"
  python3 -c '
import json
import sys

try:
    payload = json.loads(sys.argv[1])
except json.JSONDecodeError:
    raise SystemExit(1)
if not isinstance(payload, dict):
    raise SystemExit(1)
required = {"csr", "hostnames", "request_type"}
raise SystemExit(0 if required.issubset(payload) else 1)
' "$payload"
}

cloudflare_dns_creation_reconciliation() {
  local response_file="$1"
  local payload="$2"
  python3 - "$response_file" "$payload" <<'PY'
import json
import pathlib
import sys

response = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
desired = json.loads(sys.argv[2])
expected_name = str(desired.get("name", "")).rstrip(".").lower()
results = response.get("result", [])
if not expected_name or not isinstance(results, list):
    print(json.dumps({"state": "invalid", "reason": "invalid desired name or DNS result array"}))
    raise SystemExit(0)
matching = [
    record for record in results
    if isinstance(record, dict)
    and str(record.get("name", "")).rstrip(".").lower() == expected_name
]
if len(matching) == 0:
    print(json.dumps({"state": "absent"}))
elif len(matching) > 1:
    print(json.dumps({
        "state": "duplicate",
        "reason": f"found {len(matching)} records at exact hostname {expected_name}",
    }))
else:
    record = matching[0]
    record_type = record.get("type")
    desired_type = desired.get("type")
    if record_type != "CNAME" or desired_type != "CNAME":
        print(json.dumps({
            "state": "wrong_type",
            "reason": f"exact hostname has type {record_type!r}; expected CNAME",
        }))
        raise SystemExit(0)
    exact = (
        str(record.get("content", "")).rstrip(".").lower()
        == str(desired.get("content", "")).rstrip(".").lower()
        and record.get("ttl") == desired.get("ttl")
        and record.get("proxied") == desired.get("proxied")
    )
    if exact:
        print(json.dumps({
            "state": "exact",
            "response": {
                "success": True,
                "errors": [],
                "messages": [],
                "result": record,
            },
        }))
    else:
        print(json.dumps({
            "state": "drift",
            "reason": "the singleton CNAME does not match the requested content, TTL, or proxy state",
        }))
PY
}

cloudflare_is_dns_record_payload() {
  local payload="$1"
  python3 -c '
import json
import sys

try:
    payload = json.loads(sys.argv[1])
except json.JSONDecodeError:
    raise SystemExit(1)
required = {"type", "name", "content", "ttl", "proxied"}
raise SystemExit(
    0
    if isinstance(payload, dict)
    and required.issubset(payload)
    and payload.get("type") == "CNAME"
    else 1
)
' "$payload"
}

cloudflare_read_all_dns_pages() {
  local operation="$1"
  local path="$2"
  local output_file="$3"
  local first_page_file
  first_page_file=$(mktemp)
  if ! cloudflare_api_request \
    "read exact-host DNS state after ${operation}" \
    "GET" \
    "$path" \
    "" >"$first_page_file"; then
    rm -f -- "$first_page_file"
    return 1
  fi

  local total_pages
  if ! total_pages=$(python3 - "$first_page_file" <<'PY'
import json
import pathlib
import sys

response = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
result_info = response.get("result_info")
total_pages = result_info.get("total_pages") if isinstance(result_info, dict) else None
if not isinstance(total_pages, int) or isinstance(total_pages, bool) or total_pages < 0:
    print("ERROR: Cloudflare DNS list response did not contain a valid result_info.total_pages value.", file=sys.stderr)
    raise SystemExit(1)
print(max(total_pages, 1))
PY
  ); then
    rm -f -- "$first_page_file"
    return 1
  fi
  if [[ "$total_pages" -gt "$CLOUDFLARE_DNS_RECONCILIATION_MAX_PAGES" ]]; then
    echo "ERROR: Cloudflare DNS reconciliation for ${operation} requires ${total_pages} pages, exceeding the bounded limit of ${CLOUDFLARE_DNS_RECONCILIATION_MAX_PAGES}." >&2
    rm -f -- "$first_page_file"
    return 1
  fi

  mv -- "$first_page_file" "$output_file"
  local page_number=2
  local page_separator="&"
  if [[ "$path" != *"?"* ]]; then
    page_separator="?"
  fi
  while [[ "$page_number" -le "$total_pages" ]]; do
    local page_file
    local merged_file
    page_file=$(mktemp)
    merged_file=$(mktemp)
    if ! cloudflare_api_request \
      "read exact-host DNS state page ${page_number}/${total_pages} after ${operation}" \
      "GET" \
      "${path}${page_separator}page=${page_number}" \
      "" >"$page_file"; then
      rm -f -- "$page_file" "$merged_file" "$output_file"
      return 1
    fi
    if ! python3 - "$output_file" "$page_file" >"$merged_file" <<'PY'
import json
import pathlib
import sys

combined = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
page = json.loads(pathlib.Path(sys.argv[2]).read_text(encoding="utf-8"))
combined_results = combined.get("result")
page_results = page.get("result")
if not isinstance(combined_results, list) or not isinstance(page_results, list):
    print("ERROR: Cloudflare paginated DNS response did not contain result arrays.", file=sys.stderr)
    raise SystemExit(1)
combined["result"] = [*combined_results, *page_results]
combined["result_info"] = {
    "count": len(combined["result"]),
    "page": 1,
    "per_page": len(combined["result"]),
    "total_count": len(combined["result"]),
    "total_pages": 1,
}
print(json.dumps(combined))
PY
    then
      rm -f -- "$page_file" "$merged_file" "$output_file"
      return 1
    fi
    mv -- "$merged_file" "$output_file"
    rm -f -- "$page_file"
    page_number=$((page_number + 1))
  done
}

cloudflare_read_all_dns_records() {
  local operation="$1"
  local path="$2"
  local response_file
  response_file=$(mktemp)
  if ! cloudflare_read_all_dns_pages "$operation" "$path" "$response_file"; then
    rm -f -- "$response_file"
    return 1
  fi
  cloudflare_redact_credentials "$(cat "$response_file")"
  rm -f -- "$response_file"
}

cloudflare_reconcile_dns_record_create() {
  local operation="$1"
  local reconciliation_path="$2"
  local payload="$3"
  local desired_name
  desired_name=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["name"])' "$payload")
  local poll_attempt=1

  while [[ "$poll_attempt" -le "$CLOUDFLARE_DNS_RECONCILIATION_ATTEMPTS" ]]; do
    local reconciliation_file
    reconciliation_file=$(mktemp)
    if ! cloudflare_read_all_dns_pages \
      "$operation" \
      "$reconciliation_path" \
      "$reconciliation_file"; then
      rm -f -- "$reconciliation_file"
      echo "ERROR: Cloudflare ${operation} outcome is unknown because the exact-host DNS state for ${desired_name} could not be read completely. Do not send another create request; verify the hostname in Cloudflare and rerun only after its state is known." >&2
      return "$CLOUDFLARE_API_UNKNOWN_OUTCOME_STATUS"
    fi

    local reconciliation
    local reconciliation_state
    reconciliation=$(cloudflare_dns_creation_reconciliation "$reconciliation_file" "$payload")
    rm -f -- "$reconciliation_file"
    reconciliation_state=$(printf '%s' "$reconciliation" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("state", "invalid"))')
    if [[ "$reconciliation_state" == "exact" ]]; then
      echo "WARNING: Cloudflare ${operation} response was inconclusive, but bounded exact-host reconciliation found the requested singleton CNAME; reusing it." >&2
      printf '%s' "$reconciliation" | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["response"]))'
      return 0
    fi
    if [[ "$reconciliation_state" != "absent" ]]; then
      local reconciliation_reason
      reconciliation_reason=$(printf '%s' "$reconciliation" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("reason", "no reason returned"))')
      echo "ERROR: Cloudflare ${operation} outcome is indeterminate because exact-host reconciliation found ${reconciliation_state} state for ${desired_name}: ${reconciliation_reason}. Do not send another create request; resolve the DNS drift explicitly." >&2
      return "$CLOUDFLARE_API_UNKNOWN_OUTCOME_STATUS"
    fi
    if [[ "$poll_attempt" -lt "$CLOUDFLARE_DNS_RECONCILIATION_ATTEMPTS" ]]; then
      echo "WARNING: Cloudflare ${operation} is not visible after exact-host reconciliation poll ${poll_attempt}/${CLOUDFLARE_DNS_RECONCILIATION_ATTEMPTS}; waiting 2 seconds before polling again." >&2
      sleep 2
    fi
    poll_attempt=$((poll_attempt + 1))
  done

  echo "ERROR: Cloudflare ${operation} outcome remains unknown after ${CLOUDFLARE_DNS_RECONCILIATION_ATTEMPTS} complete exact-host polls for ${desired_name}. Propagation delay does not prove absence. Do not send another create request; inspect the hostname and safely rerun reconciliation later." >&2
  return "$CLOUDFLARE_API_UNKNOWN_OUTCOME_STATUS"
}

cloudflare_classify_exact_cname() {
  local expected_name="$1"
  local expected_content="$2"
  local expected_proxied="$3"
  local rerun_command="$4"

  python3 -c '
import json
import sys

expected_name = sys.argv[1].rstrip(".").lower()
expected_content = sys.argv[2].rstrip(".").lower()
expected_proxied_text = sys.argv[3]
rerun_command = sys.argv[4]
if expected_proxied_text not in {"true", "false"}:
    print("ERROR: Expected proxied state must be true or false.", file=sys.stderr)
    raise SystemExit(1)
expected_proxied = expected_proxied_text == "true"
response = json.load(sys.stdin)
records = response.get("result", [])
if not isinstance(records, list):
    print("ERROR: Cloudflare exact-host DNS lookup returned no result array.", file=sys.stderr)
    raise SystemExit(1)
matching = [
    record for record in records
    if isinstance(record, dict)
    and str(record.get("name", "")).rstrip(".").lower() == expected_name
]
if len(matching) > 1:
    print(
        f"ERROR: Found {len(matching)} DNS records at exact hostname {sys.argv[1]}; expected at most one CNAME.",
        file=sys.stderr,
    )
    for record in matching:
        print(
            "  id={} type={} content={} proxied={}".format(
                record.get("id", "<missing>"),
                record.get("type", "<missing>"),
                record.get("content", "<missing>"),
                record.get("proxied", "<missing>"),
            ),
            file=sys.stderr,
        )
    print(
        f"ACTION: Remove the duplicate or conflicting exact-host records in Cloudflare, then rerun {rerun_command}.",
        file=sys.stderr,
    )
    raise SystemExit(1)
if not matching:
    print(json.dumps({"state": "absent", "id": ""}))
    raise SystemExit(0)
record = matching[0]
record_type = record.get("type")
record_id = record.get("id")
if record_type != "CNAME" or not isinstance(record_id, str) or not record_id:
    print(
        f"ERROR: DNS record at {sys.argv[1]} has type {record_type!r}; expected one CNAME.",
        file=sys.stderr,
    )
    print(
        f"ACTION: Remove or convert the conflicting record in Cloudflare, then rerun {rerun_command}.",
        file=sys.stderr,
    )
    raise SystemExit(1)
content = str(record.get("content", "")).rstrip(".").lower()
proxied = record.get("proxied") is True
state = "exact" if content == expected_content and proxied == expected_proxied else "drift"
print(json.dumps({
    "state": state,
    "id": record_id,
    "content": record.get("content", ""),
    "proxied": proxied,
}))
' "$expected_name" "$expected_content" "$expected_proxied" "$rerun_command"
}

cloudflare_origin_certificate_reconciliation() {
  local response_file="$1"
  local payload="$2"
  local reconciliation_dir
  local previous_umask
  previous_umask=$(umask)
  umask 077
  reconciliation_dir=$(mktemp -d)
  umask "$previous_umask"

  local preparation
  if ! preparation=$(python3 - "$response_file" "$payload" "$reconciliation_dir" <<'PY'
import json
import pathlib
import sys

response_path = pathlib.Path(sys.argv[1])
output_path = pathlib.Path(sys.argv[3])
try:
    response = json.loads(response_path.read_text(encoding="utf-8"))
    desired = json.loads(sys.argv[2])
except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
    print(json.dumps({"state": "invalid", "reason": f"invalid JSON: {error}"}))
    raise SystemExit(0)

csr = desired.get("csr") if isinstance(desired, dict) else None
hostnames = desired.get("hostnames") if isinstance(desired, dict) else None
request_type = desired.get("request_type") if isinstance(desired, dict) else None
requested_validity = desired.get("requested_validity") if isinstance(desired, dict) else None
if (
    not isinstance(csr, str)
    or not csr.strip()
    or not isinstance(hostnames, list)
    or not hostnames
    or any(not isinstance(hostname, str) or not hostname for hostname in hostnames)
    or not isinstance(request_type, str)
    or not request_type
    or not isinstance(requested_validity, int)
    or requested_validity <= 1
):
    print(json.dumps({"state": "invalid", "reason": "invalid Origin CA request payload"}))
    raise SystemExit(0)

raw_results = response.get("result", []) if isinstance(response, dict) else []
if isinstance(raw_results, dict):
    results = [raw_results]
elif isinstance(raw_results, list):
    results = raw_results
else:
    print(json.dumps({"state": "invalid", "reason": "Origin CA result is not an object or array"}))
    raise SystemExit(0)

(output_path / "request.csr.pem").write_text(csr, encoding="utf-8")
(output_path / "minimum-validity-seconds").write_text(
    str((requested_validity - 1) * 24 * 60 * 60),
    encoding="utf-8",
)
exact_metadata_without_certificate = False
candidate_count = 0
expected_hostnames = sorted(hostnames)
for index, result in enumerate(results):
    if not isinstance(result, dict):
        continue
    result_hostnames = result.get("hostnames")
    exact_metadata = (
        isinstance(result_hostnames, list)
        and all(isinstance(hostname, str) for hostname in result_hostnames)
        and sorted(result_hostnames) == expected_hostnames
        and result.get("request_type") == request_type
    )
    certificate = result.get("certificate")
    if not isinstance(certificate, str) or not certificate.strip():
        if exact_metadata:
            exact_metadata_without_certificate = True
        continue
    candidate_path = output_path / f"candidate-{index}"
    candidate_path.with_suffix(".pem").write_text(certificate, encoding="utf-8")
    candidate_path.with_suffix(".json").write_text(json.dumps(result), encoding="utf-8")
    if exact_metadata:
        candidate_path.with_suffix(".exact-metadata").touch()
    candidate_count += 1

print(json.dumps({
    "state": "prepared",
    "candidateCount": candidate_count,
    "exactMetadataWithoutCertificate": exact_metadata_without_certificate,
}))
PY
  ); then
    rm -rf -- "$reconciliation_dir"
    printf '%s' '{"state":"invalid","reason":"could not prepare Origin CA reconciliation"}'
    return 0
  fi

  local preparation_state
  preparation_state=$(printf '%s' "$preparation" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("state", "invalid"))')
  if [[ "$preparation_state" != "prepared" ]]; then
    rm -rf -- "$reconciliation_dir"
    printf '%s' "$preparation"
    return 0
  fi

  if ! openssl req \
    -in "${reconciliation_dir}/request.csr.pem" \
    -pubkey \
    -noout \
    | openssl pkey -pubin -outform DER >"${reconciliation_dir}/request-public-key.der" 2>/dev/null; then
    rm -rf -- "$reconciliation_dir"
    printf '%s' '{"state":"invalid","reason":"could not extract the Origin CA CSR public key"}'
    return 0
  fi

  local -a public_key_matches=()
  local exact_metadata_invalid_certificate=false
  local certificate_file
  for certificate_file in "${reconciliation_dir}"/candidate-*.pem; do
    if [[ ! -f "$certificate_file" ]]; then
      break
    fi
    local candidate_base="${certificate_file%.pem}"
    if ! openssl x509 \
      -in "$certificate_file" \
      -pubkey \
      -noout \
      | openssl pkey -pubin -outform DER >"${candidate_base}.public-key.der" 2>/dev/null; then
      if [[ -f "${candidate_base}.exact-metadata" ]]; then
        exact_metadata_invalid_certificate=true
      fi
      continue
    fi
    if cmp -s "${reconciliation_dir}/request-public-key.der" "${candidate_base}.public-key.der"; then
      public_key_matches+=("$candidate_base")
    fi
  done

  if [[ "${#public_key_matches[@]}" -gt 1 ]]; then
    rm -rf -- "$reconciliation_dir"
    printf '%s' '{"state":"duplicate","reason":"multiple Origin CA certificates have the CSR public key"}'
    return 0
  fi

  if [[ "${#public_key_matches[@]}" -eq 1 ]]; then
    local matching_base="${public_key_matches[0]}"
    if [[ ! -f "${matching_base}.exact-metadata" ]]; then
      rm -rf -- "$reconciliation_dir"
      printf '%s' '{"state":"drift","reason":"the public-key-matched Origin CA certificate has different hostnames or request type"}'
      return 0
    fi
    local minimum_validity_seconds
    minimum_validity_seconds=$(cat "${reconciliation_dir}/minimum-validity-seconds")
    if ! openssl x509 \
      -in "${matching_base}.pem" \
      -checkend "$minimum_validity_seconds" \
      -noout >/dev/null 2>&1; then
      rm -rf -- "$reconciliation_dir"
      printf '%s' '{"state":"drift","reason":"the public-key-matched Origin CA certificate expires too soon for the requested validity"}'
      return 0
    fi
    local matched_response
    matched_response=$(python3 - "${matching_base}.json" <<'PY'
import json
import pathlib
import sys

result = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
print(json.dumps({
    "state": "exact",
    "response": {
        "success": True,
        "errors": [],
        "messages": [],
        "result": result,
    },
}))
PY
)
    rm -rf -- "$reconciliation_dir"
    printf '%s' "$matched_response"
    return 0
  fi

  local exact_metadata_without_certificate
  exact_metadata_without_certificate=$(printf '%s' "$preparation" | python3 -c 'import json,sys; print(str(json.load(sys.stdin).get("exactMetadataWithoutCertificate") is True).lower())')
  rm -rf -- "$reconciliation_dir"
  if [[ "$exact_metadata_without_certificate" == "true" || "$exact_metadata_invalid_certificate" == "true" ]]; then
    printf '%s' '{"state":"indeterminate","reason":"an exact-metadata Origin CA result did not contain a usable certificate"}'
    return 0
  fi
  printf '%s' '{"state":"absent"}'
}

cloudflare_reconcile_origin_certificate_create() {
  local operation="$1"
  local reconciliation_path="$2"
  local payload="$3"
  local poll_attempt=1

  while [[ "$poll_attempt" -le "$CLOUDFLARE_ORIGIN_CA_RECONCILIATION_ATTEMPTS" ]]; do
    local reconciliation_file
    reconciliation_file=$(mktemp)
    if ! cloudflare_api_request \
      "poll Origin CA state after ${operation}" \
      "GET" \
      "$reconciliation_path" \
      "" >"$reconciliation_file"; then
      rm -f -- "$reconciliation_file"
      echo "ERROR: Cloudflare ${operation} outcome is unknown because the Origin CA list could not be read; path=${reconciliation_path}. Do not create another certificate; retain the original CSR and private key and resume reconciliation later." >&2
      return "$CLOUDFLARE_API_UNKNOWN_OUTCOME_STATUS"
    fi

    local total_pages
    if ! total_pages=$(python3 - "$reconciliation_file" <<'PY'
import json
import pathlib
import sys

response = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
result_info = response.get("result_info")
total_pages = result_info.get("total_pages") if isinstance(result_info, dict) else None
if not isinstance(total_pages, int) or isinstance(total_pages, bool) or total_pages < 0:
    print("ERROR: Cloudflare Origin CA list response did not contain a valid result_info.total_pages value.", file=sys.stderr)
    raise SystemExit(1)
print(max(total_pages, 1))
PY
    ); then
      rm -f -- "$reconciliation_file"
      echo "ERROR: Cloudflare ${operation} response was inconclusive and the Origin CA list pagination metadata was invalid; path=${reconciliation_path}. Refusing to reissue because certificate absence cannot be established." >&2
      return "$CLOUDFLARE_API_UNKNOWN_OUTCOME_STATUS"
    fi
    if [[ "$total_pages" -gt "$CLOUDFLARE_ORIGIN_CA_RECONCILIATION_MAX_PAGES" ]]; then
      rm -f -- "$reconciliation_file"
      echo "ERROR: Cloudflare ${operation} response was inconclusive and Origin CA reconciliation requires ${total_pages} pages, exceeding the bounded limit of ${CLOUDFLARE_ORIGIN_CA_RECONCILIATION_MAX_PAGES}; path=${reconciliation_path}. Narrow the account certificate inventory or reconcile it manually before rerunning." >&2
      return "$CLOUDFLARE_API_UNKNOWN_OUTCOME_STATUS"
    fi

    local page_number=2
    while [[ "$page_number" -le "$total_pages" ]]; do
      local page_file
      local merged_file
      page_file=$(mktemp)
      merged_file=$(mktemp)
      if ! cloudflare_api_request \
        "poll Origin CA state page ${page_number}/${total_pages} after ${operation}" \
        "GET" \
        "${reconciliation_path}&page=${page_number}" \
          "" >"$page_file"; then
        rm -f -- "$page_file" "$merged_file" "$reconciliation_file"
        echo "ERROR: Cloudflare ${operation} outcome is unknown because Origin CA reconciliation page ${page_number}/${total_pages} could not be read; path=${reconciliation_path}. Do not create another certificate; retain the original CSR and private key and resume reconciliation later." >&2
        return "$CLOUDFLARE_API_UNKNOWN_OUTCOME_STATUS"
      fi
      if ! python3 - "$reconciliation_file" "$page_file" >"$merged_file" <<'PY'
import json
import pathlib
import sys

combined = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
page = json.loads(pathlib.Path(sys.argv[2]).read_text(encoding="utf-8"))
combined_results = combined.get("result")
page_results = page.get("result")
if not isinstance(combined_results, list) or not isinstance(page_results, list):
    print("ERROR: Cloudflare Origin CA paginated response did not contain result arrays.", file=sys.stderr)
    raise SystemExit(1)
combined["result"] = [*combined_results, *page_results]
combined["result_info"] = {
    "count": len(combined["result"]),
    "page": 1,
    "per_page": len(combined["result"]),
    "total_count": len(combined["result"]),
    "total_pages": 1,
}
print(json.dumps(combined))
PY
      then
        rm -f -- "$page_file" "$merged_file" "$reconciliation_file"
        echo "ERROR: Cloudflare ${operation} response was inconclusive and Origin CA reconciliation could not combine page ${page_number}/${total_pages}; path=${reconciliation_path}. Refusing to reissue because certificate absence cannot be established." >&2
        return "$CLOUDFLARE_API_UNKNOWN_OUTCOME_STATUS"
      fi
      mv -- "$merged_file" "$reconciliation_file"
      rm -f -- "$page_file"
      page_number=$((page_number + 1))
    done

    local reconciliation
    local reconciliation_state
    reconciliation=$(cloudflare_origin_certificate_reconciliation "$reconciliation_file" "$payload")
    rm -f -- "$reconciliation_file"
    reconciliation_state=$(printf '%s' "$reconciliation" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("state", "invalid"))')
    if [[ "$reconciliation_state" == "exact" ]]; then
      echo "WARNING: Cloudflare ${operation} response was inconclusive, but bounded reconciliation matched the issued certificate to the original CSR public key; reusing it." >&2
      printf '%s' "$reconciliation" | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["response"]))'
      return 0
    fi
    if [[ "$reconciliation_state" != "absent" ]]; then
      local reconciliation_reason
      reconciliation_reason=$(printf '%s' "$reconciliation" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("reason", "no reason returned"))')
      echo "ERROR: Cloudflare ${operation} outcome is unknown because Origin CA reconciliation found ${reconciliation_state} state; path=${reconciliation_path}; reason=${reconciliation_reason}. Do not create another certificate; retain the original CSR and private key and resolve or resume reconciliation." >&2
      return "$CLOUDFLARE_API_UNKNOWN_OUTCOME_STATUS"
    fi
    if [[ "$poll_attempt" -lt "$CLOUDFLARE_ORIGIN_CA_RECONCILIATION_ATTEMPTS" ]]; then
      echo "WARNING: Cloudflare ${operation} is not visible in the Origin CA list after reconciliation poll ${poll_attempt}/${CLOUDFLARE_ORIGIN_CA_RECONCILIATION_ATTEMPTS}; waiting 2 seconds before polling again." >&2
      sleep 2
    fi
    poll_attempt=$((poll_attempt + 1))
  done

  echo "ERROR: Cloudflare ${operation} outcome remains unknown after ${CLOUDFLARE_ORIGIN_CA_RECONCILIATION_ATTEMPTS} successful list polls; path=${reconciliation_path}. Propagation delay does not prove absence. Do not create another certificate; retain the original CSR and private key and resume reconciliation later." >&2
  return "$CLOUDFLARE_API_UNKNOWN_OUTCOME_STATUS"
}

cloudflare_request_was_not_sent() {
  local curl_status="$1"
  case "$curl_status" in
    1|2|3|4|5|6|7) return 0 ;;
    *) return 1 ;;
  esac
}

cloudflare_api_request() {
  local operation="$1"
  local method="$2"
  local path="$3"
  local payload="$4"
  local reconciliation_path="${5:-}"
  if [[ ( "$method" == "POST" || "$method" == "DELETE" ) && -z "$reconciliation_path" ]]; then
    echo "ERROR: Cloudflare ${operation} uses ${method} and requires a reconciliation path before it can be retried safely." >&2
    return 1
  fi
  if ! cloudflare_prepare_curl_config; then
    return 1
  fi
  local response_file
  local error_file
  response_file=$(mktemp)
  error_file=$(mktemp)
  local attempt=1

  while [[ "$attempt" -le "$CLOUDFLARE_API_MAX_ATTEMPTS" ]]; do
    local -a curl_args=(
      --silent
      --show-error
      --connect-timeout 10
      --max-time 30
      --request "$method"
      --output "$response_file"
      --write-out "%{http_code}"
      --config "$CLOUDFLARE_CURL_CONFIG_FILE"
      "${CLOUDFLARE_API_BASE_URL}${path}"
      --header "Content-Type: application/json"
    )
    if [[ -n "$payload" ]]; then
      curl_args+=(--data "$payload")
    fi

    local http_status
    local curl_status
    if http_status=$(curl "${curl_args[@]}" 2>"$error_file"); then
      curl_status=0
    else
      curl_status=$?
    fi
    local response_state
    response_state=$(cloudflare_response_state "$response_file")
    if [[ "$curl_status" -eq 0 && "$http_status" =~ ^2[0-9][0-9]$ && "$response_state" == "success" ]]; then
      cloudflare_redact_credentials "$(cat "$response_file")"
      rm -f "$response_file" "$error_file"
      return 0
    fi

    if [[ "$method" == "POST" ]]; then
      if [[ "$curl_status" -ne 0 ]] && cloudflare_request_was_not_sent "$curl_status"; then
        :
      elif [[ "$curl_status" -eq 0 && "$http_status" =~ ^4[0-9][0-9]$ && "$response_state" != "success" ]]; then
        local rejected_response_body
        local rejected_transport_error
        rejected_response_body=$(cloudflare_redact_credentials "$(cloudflare_error_body "$response_file")")
        rejected_transport_error=$(cloudflare_redact_credentials "$(sed -n '1,20p' "$error_file")")
        echo "ERROR: Cloudflare ${operation} was definitively rejected; method=${method}; path=${path}; curl_status=${curl_status}; http_status=${http_status}; response=${rejected_response_body}; transport_error=${rejected_transport_error:-none}. The rejected request will not be retried; correct the request or token permissions before trying again." >&2
        rm -f -- "$response_file" "$error_file"
        return 1
      elif cloudflare_is_origin_certificate_payload "$payload"; then
          local origin_reconciliation_file
          local origin_reconciliation_status
          origin_reconciliation_file=$(mktemp)
          if cloudflare_reconcile_origin_certificate_create \
            "$operation" \
            "$reconciliation_path" \
            "$payload" >"$origin_reconciliation_file"; then
            cloudflare_redact_credentials "$(cat "$origin_reconciliation_file")"
            rm -f -- "$origin_reconciliation_file" "$response_file" "$error_file"
            return 0
          else
            origin_reconciliation_status=$?
          fi
          rm -f -- "$origin_reconciliation_file" "$response_file" "$error_file"
          if [[ "$origin_reconciliation_status" -eq "$CLOUDFLARE_API_UNKNOWN_OUTCOME_STATUS" ]]; then
            return "$CLOUDFLARE_API_UNKNOWN_OUTCOME_STATUS"
          fi
          return 1
      elif cloudflare_is_dns_record_payload "$payload"; then
        local dns_reconciliation_file
        local dns_reconciliation_status
        dns_reconciliation_file=$(mktemp)
        if cloudflare_reconcile_dns_record_create \
          "$operation" \
          "$reconciliation_path" \
          "$payload" >"$dns_reconciliation_file"; then
          cloudflare_redact_credentials "$(cat "$dns_reconciliation_file")"
          rm -f -- "$dns_reconciliation_file" "$response_file" "$error_file"
          return 0
        else
          dns_reconciliation_status=$?
        fi
        rm -f -- "$dns_reconciliation_file" "$response_file" "$error_file"
        if [[ "$dns_reconciliation_status" -eq "$CLOUDFLARE_API_UNKNOWN_OUTCOME_STATUS" ]]; then
          return "$CLOUDFLARE_API_UNKNOWN_OUTCOME_STATUS"
        fi
        return 1
      else
        echo "ERROR: Cloudflare ${operation} uses an unsupported POST payload, so its ambiguous outcome cannot be reconciled safely. No automatic retry will be attempted." >&2
        rm -f -- "$response_file" "$error_file"
        return "$CLOUDFLARE_API_UNKNOWN_OUTCOME_STATUS"
      fi
    fi

    if [[ "$method" == "DELETE" ]]; then
      local reconciliation_file
      reconciliation_file=$(mktemp)
      if cloudflare_optional_get_request \
        "reconcile ${operation}" \
        "$reconciliation_path" >"$reconciliation_file"; then
        local deletion_state
        deletion_state=$(cloudflare_response_state "$reconciliation_file")
        if [[ "$deletion_state" == "not_found" ]]; then
          echo "WARNING: Cloudflare ${operation} response was inconclusive, but reconciliation confirmed that the resource is absent." >&2
          printf '{"success":true,"result":{"reconciled":true}}'
          rm -f "$reconciliation_file" "$response_file" "$error_file"
          return 0
        fi
      else
        rm -f "$reconciliation_file" "$response_file" "$error_file"
        return 1
      fi
      rm -f "$reconciliation_file"
    fi

    local response_body
    response_body=$(cloudflare_redact_credentials "$(cloudflare_error_body "$response_file")")
    local transport_error
    transport_error=$(cloudflare_redact_credentials "$(sed -n '1,20p' "$error_file")")
    if [[ "$attempt" -lt "$CLOUDFLARE_API_MAX_ATTEMPTS" ]]; then
      echo "WARNING: Cloudflare ${operation} attempt ${attempt}/${CLOUDFLARE_API_MAX_ATTEMPTS} failed; method=${method}; path=${path}; curl_status=${curl_status}; http_status=${http_status:-none}; response=${response_body}; transport_error=${transport_error:-none}; retrying in 2 seconds." >&2
      sleep 2
      attempt=$((attempt + 1))
      continue
    fi

    echo "ERROR: Cloudflare ${operation} failed after ${CLOUDFLARE_API_MAX_ATTEMPTS} attempts; method=${method}; path=${path}; curl_status=${curl_status}; http_status=${http_status:-none}; response=${response_body}; transport_error=${transport_error:-none}. Check the zone ID, API token permissions, requested resource, and Cloudflare plan." >&2
    rm -f "$response_file" "$error_file"
    return 1
  done
}

cloudflare_optional_get_request() {
  local operation="$1"
  local path="$2"
  if ! cloudflare_prepare_curl_config; then
    return 1
  fi
  local response_file
  local error_file
  response_file=$(mktemp)
  error_file=$(mktemp)
  local attempt=1

  while [[ "$attempt" -le "$CLOUDFLARE_API_MAX_ATTEMPTS" ]]; do
    local http_status
    local curl_status
    if http_status=$(curl \
      --silent \
      --show-error \
      --connect-timeout 10 \
      --max-time 30 \
      --request GET \
      --output "$response_file" \
      --write-out "%{http_code}" \
      --config "$CLOUDFLARE_CURL_CONFIG_FILE" \
      "${CLOUDFLARE_API_BASE_URL}${path}" \
      --header "Content-Type: application/json" \
      2>"$error_file"); then
      curl_status=0
    else
      curl_status=$?
    fi
    local response_state
    response_state=$(cloudflare_response_state "$response_file")
    if [[ "$curl_status" -eq 0 && "$http_status" =~ ^2[0-9][0-9]$ && "$response_state" == "success" ]]; then
      cloudflare_redact_credentials "$(cat "$response_file")"
      rm -f "$response_file" "$error_file"
      return 0
    fi
    if [[ "$curl_status" -eq 0 && "$http_status" == "404" ]]; then
      printf '{"success":false,"result":null,"errors":[{"message":"not found"}]}'
      rm -f "$response_file" "$error_file"
      return 0
    fi

    local response_body
    response_body=$(cloudflare_redact_credentials "$(cloudflare_error_body "$response_file")")
    local transport_error
    transport_error=$(cloudflare_redact_credentials "$(sed -n '1,20p' "$error_file")")
    if [[ "$attempt" -lt "$CLOUDFLARE_API_MAX_ATTEMPTS" ]]; then
      echo "WARNING: Cloudflare ${operation} attempt ${attempt}/${CLOUDFLARE_API_MAX_ATTEMPTS} failed; method=GET; path=${path}; curl_status=${curl_status}; http_status=${http_status:-none}; response=${response_body}; transport_error=${transport_error:-none}; retrying in 2 seconds." >&2
      sleep 2
      attempt=$((attempt + 1))
      continue
    fi

    echo "ERROR: Cloudflare ${operation} failed after ${CLOUDFLARE_API_MAX_ATTEMPTS} attempts; method=GET; path=${path}; curl_status=${curl_status}; http_status=${http_status:-none}; response=${response_body}; transport_error=${transport_error:-none}. Check the zone ID, API token permissions, requested ruleset phase, and Cloudflare plan." >&2
    rm -f "$response_file" "$error_file"
    return 1
  done
}
