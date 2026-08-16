#!/usr/bin/env bash
# Provision the MCP Registry DNS ownership proof and GitHub Actions secret.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLOUDFLARE_ENV_FILE="${SCRIPT_DIR}/.env"
DOMAIN="expense-budget-tracker.com"
EXPECTED_REPO="kirill-markin/expense-budget-tracker"
SECRET_NAME="MCP_PRIVATE_KEY"
KEY_DIR=""
KEY_FILE=""
PRIVATE_KEY=""

if [[ $# -ne 0 ]]; then
  echo "ERROR: This script accepts no arguments; it provisions ${DOMAIN} for ${EXPECTED_REPO}." >&2
  exit 1
fi

if [[ ! -f "$CLOUDFLARE_ENV_FILE" ]]; then
  echo "ERROR: Missing ${CLOUDFLARE_ENV_FILE}. Add CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID to that gitignored file before running this script." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$CLOUDFLARE_ENV_FILE"
set +a
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/cloudflare-api.sh"

require_command() {
  local command_name="$1"

  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "ERROR: ${command_name} is required to provision the MCP Registry credential." >&2
    exit 1
  fi
}

require_command base64
require_command curl
require_command dig
require_command gh
require_command mktemp
require_command openssl
require_command python3

cloudflare_require_api_token
: "${CLOUDFLARE_ZONE_ID:?Set CLOUDFLARE_ZONE_ID in scripts/cloudflare/.env}"
cloudflare_prepare_curl_config

cleanup() {
  unset PRIVATE_KEY
  if [[ -n "$KEY_FILE" && -f "$KEY_FILE" ]]; then
    rm -f -- "$KEY_FILE"
  fi
  if [[ -n "$KEY_DIR" && -d "$KEY_DIR" && ! -L "$KEY_DIR" ]]; then
    if ! rmdir -- "$KEY_DIR"; then
      echo "WARNING: Temporary MCP Registry key directory ${KEY_DIR} contains unexpected files and was not removed." >&2
    fi
  fi
  cloudflare_cleanup_curl_config
}
trap 'cleanup' EXIT
trap 'cleanup; exit 129' HUP
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

run_gh_read() {
  local operation="$1"
  shift
  local error_file
  error_file="$(mktemp)"
  local attempt=1
  local max_attempts=3

  while [[ "$attempt" -le "$max_attempts" ]]; do
    local output
    local command_status
    if output=$("$@" 2>"$error_file"); then
      rm -f -- "$error_file"
      printf '%s' "$output"
      return 0
    else
      command_status=$?
    fi

    if [[ "$attempt" -lt "$max_attempts" ]]; then
      echo "WARNING: ${operation} failed with status ${command_status}; retrying in 2 seconds (${attempt}/${max_attempts})." >&2
      sleep 2
      attempt=$((attempt + 1))
      continue
    fi

    echo "ERROR: ${operation} failed after ${max_attempts} attempts with status ${command_status}." >&2
    sed -n '1,40p' "$error_file" >&2
    rm -f -- "$error_file"
    return "$command_status"
  done
}

fetch_github_secrets() {
  local repository="$1"
  run_gh_read \
    "GitHub Actions secret lookup for ${repository}" \
    gh secret list --repo "$repository" --json name
}

github_secret_exists() {
  local secrets_json="$1"

  python3 -c '
import json
import sys

secrets = json.loads(sys.argv[1])
secret_name = sys.argv[2]
if not isinstance(secrets, list):
    print("ERROR: GitHub secret lookup did not return a JSON array.", file=sys.stderr)
    raise SystemExit(2)
raise SystemExit(0 if any(
    isinstance(secret, dict) and secret.get("name") == secret_name
    for secret in secrets
) else 1)
' "$secrets_json" "$SECRET_NAME"
}

fetch_root_txt_records() {
  cloudflare_read_all_dns_records \
    "read root TXT records for MCP Registry ownership" \
    "/zones/${CLOUDFLARE_ZONE_ID}/dns_records?type=TXT&name=${DOMAIN}&per_page=100"
}

classify_mcp_txt_records() {
  python3 -c '
import base64
import binascii
import json
import re
import sys

domain = sys.argv[1].rstrip(".").lower()
response = json.load(sys.stdin)
records = response.get("result")
if response.get("success") is not True or not isinstance(records, list):
    print("ERROR: Cloudflare TXT lookup did not return a successful result array.", file=sys.stderr)
    raise SystemExit(1)

root_txt_records = [
    record
    for record in records
    if isinstance(record, dict)
    and str(record.get("name", "")).rstrip(".").lower() == domain
    and record.get("type") == "TXT"
]
candidates = [
    record
    for record in root_txt_records
    if str(record.get("content", "")).startswith("v=MCPv1;")
]
pattern = re.compile(r"^v=MCPv1; k=ed25519; p=([A-Za-z0-9+/]+={0,2})$")
valid = []
invalid = []
for record in candidates:
    content = str(record.get("content", ""))
    match = pattern.fullmatch(content)
    if match is None:
        invalid.append(record)
        continue
    try:
        decoded = base64.b64decode(match.group(1), validate=True)
    except (binascii.Error, ValueError):
        invalid.append(record)
        continue
    if len(decoded) != 32:
        invalid.append(record)
        continue
    valid.append(record)

print(json.dumps({
    "rootTxtCount": len(root_txt_records),
    "candidateCount": len(candidates),
    "validCount": len(valid),
    "invalidCount": len(invalid),
    "validContent": valid[0].get("content", "") if len(valid) == 1 else "",
}))
' "$DOMAIN"
}

read_mcp_dns_state() {
  local records
  records="$(fetch_root_txt_records)"
  printf '%s' "$records" | classify_mcp_txt_records
}

reconcile_created_txt_record() {
  local expected_content="$1"
  local max_attempts=5
  local attempt=1

  while [[ "$attempt" -le "$max_attempts" ]]; do
    local state
    local valid_count
    local invalid_count
    local valid_content
    state="$(read_mcp_dns_state)"
    valid_count="$(printf '%s' "$state" | python3 -c 'import json,sys; print(json.load(sys.stdin)["validCount"])')"
    invalid_count="$(printf '%s' "$state" | python3 -c 'import json,sys; print(json.load(sys.stdin)["invalidCount"])')"
    valid_content="$(printf '%s' "$state" | python3 -c 'import json,sys; print(json.load(sys.stdin)["validContent"])')"

    if [[ "$valid_count" -eq 1 && "$invalid_count" -eq 0 && "$valid_content" == "$expected_content" ]]; then
      return 0
    fi
    if [[ "$valid_count" -gt 0 || "$invalid_count" -gt 0 ]]; then
      echo "ERROR: Cloudflare reconciliation found MCP Registry TXT state that does not match the generated key; valid=${valid_count}, invalid=${invalid_count}." >&2
      return 1
    fi

    if [[ "$attempt" -lt "$max_attempts" ]]; then
      echo "WARNING: The created MCP Registry TXT record is not visible through the Cloudflare API; retrying in 2 seconds (${attempt}/${max_attempts})." >&2
      sleep 2
    fi
    attempt=$((attempt + 1))
  done

  echo "ERROR: The Cloudflare TXT-create outcome remains unknown after ${max_attempts} complete state reads." >&2
  return "$CLOUDFLARE_API_UNKNOWN_OUTCOME_STATUS"
}

verify_public_dns() {
  local expected_content="$1"
  local max_attempts=30
  local retry_delay_seconds=10
  local -a resolvers=("1.1.1.1" "8.8.8.8")
  local attempt=1

  while [[ "$attempt" -le "$max_attempts" ]]; do
    local all_resolvers_match=true
    local resolver
    for resolver in "${resolvers[@]}"; do
      local answers
      if answers=$(dig +time=5 +tries=1 +short TXT "$DOMAIN" "@${resolver}"); then
        if ! printf '%s\n' "$answers" | python3 -c '
import shlex
import sys

expected = sys.argv[1]
answers = []
for line in sys.stdin:
    stripped = line.strip()
    if not stripped:
        continue
    try:
        answers.append("".join(shlex.split(stripped)))
    except ValueError:
        raise SystemExit(2)
raise SystemExit(0 if expected in answers else 1)
' "$expected_content"; then
          all_resolvers_match=false
        fi
      else
        all_resolvers_match=false
      fi
    done

    if [[ "$all_resolvers_match" == "true" ]]; then
      echo "Verified the MCP Registry ownership TXT record through Cloudflare and Google public DNS resolvers."
      return 0
    fi

    if [[ "$attempt" -lt "$max_attempts" ]]; then
      echo "WARNING: MCP Registry ownership TXT propagation is incomplete; retrying in ${retry_delay_seconds} seconds (${attempt}/${max_attempts})." >&2
      sleep "$retry_delay_seconds"
    fi
    attempt=$((attempt + 1))
  done

  echo "ERROR: The MCP Registry ownership TXT record did not appear through both public resolvers after ${max_attempts} attempts." >&2
  echo "ACTION: Wait for DNS propagation, then rerun this script. It will reuse the existing DNS record and will not rotate the key." >&2
  return 1
}

set_github_secret() {
  local repository="$1"
  local private_key="$2"
  local error_file
  error_file="$(mktemp)"
  local attempt=1
  local max_attempts=3

  while [[ "$attempt" -le "$max_attempts" ]]; do
    local command_status
    if printf '%s' "$private_key" | gh secret set "$SECRET_NAME" --repo "$repository" 2>"$error_file" >/dev/null; then
      rm -f -- "$error_file"
      return 0
    else
      command_status=$?
    fi

    if [[ "$attempt" -lt "$max_attempts" ]]; then
      echo "WARNING: GitHub secret update failed with status ${command_status}; retrying the same key in 2 seconds (${attempt}/${max_attempts})." >&2
      sleep 2
      attempt=$((attempt + 1))
      continue
    fi

    echo "ERROR: GitHub secret update failed after ${max_attempts} attempts with status ${command_status}." >&2
    sed -n '1,40p' "$error_file" >&2
    rm -f -- "$error_file"
    return "$command_status"
  done
}

REPO="$(run_gh_read "GitHub repository resolution" gh repo view --json nameWithOwner --jq .nameWithOwner)"
if [[ "$REPO" != "$EXPECTED_REPO" ]]; then
  echo "ERROR: Current checkout resolves to GitHub repository ${REPO}; expected ${EXPECTED_REPO}." >&2
  echo "ACTION: Run this script from the ${EXPECTED_REPO} checkout." >&2
  exit 1
fi

ZONE_RESPONSE="$(cloudflare_api_request \
  "read MCP Registry credential zone" \
  "GET" \
  "/zones/${CLOUDFLARE_ZONE_ID}" \
  "")"
ZONE_NAME="$(printf '%s' "$ZONE_RESPONSE" | python3 -c '
import json
import sys

response = json.load(sys.stdin)
result = response.get("result")
name = result.get("name") if isinstance(result, dict) else None
if response.get("success") is not True or not isinstance(name, str) or not name:
    print("ERROR: Cloudflare zone lookup returned no valid zone name.", file=sys.stderr)
    raise SystemExit(1)
print(name.rstrip(".").lower())
')"
if [[ "$ZONE_NAME" != "$DOMAIN" ]]; then
  echo "ERROR: CLOUDFLARE_ZONE_ID resolves to ${ZONE_NAME}; expected ${DOMAIN}." >&2
  echo "ACTION: Correct scripts/cloudflare/.env before provisioning the Registry credential." >&2
  exit 1
fi

GITHUB_SECRETS_JSON="$(fetch_github_secrets "$REPO")"
if github_secret_exists "$GITHUB_SECRETS_JSON"; then
  GITHUB_SECRET_EXISTS=true
else
  secret_lookup_status=$?
  if [[ "$secret_lookup_status" -ne 1 ]]; then
    exit "$secret_lookup_status"
  fi
  GITHUB_SECRET_EXISTS=false
fi

DNS_STATE="$(read_mcp_dns_state)"
MCP_VALID_COUNT="$(printf '%s' "$DNS_STATE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["validCount"])')"
MCP_INVALID_COUNT="$(printf '%s' "$DNS_STATE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["invalidCount"])')"
MCP_VALID_CONTENT="$(printf '%s' "$DNS_STATE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["validContent"])')"

if [[ "$MCP_INVALID_COUNT" -gt 0 ]]; then
  echo "ERROR: Found ${MCP_INVALID_COUNT} malformed or unsupported MCP Registry TXT record(s) at ${DOMAIN}." >&2
  echo "ACTION: Resolve only the root TXT records beginning with 'v=MCPv1;' before rerunning; preserve all unrelated TXT records." >&2
  exit 1
fi
if [[ "$MCP_VALID_COUNT" -gt 1 ]]; then
  echo "ERROR: Found ${MCP_VALID_COUNT} valid MCP Registry ownership TXT records at ${DOMAIN}; exactly one is allowed." >&2
  echo "ACTION: Keep the record matching the intended ${SECRET_NAME} key and remove only duplicate MCP Registry records before rerunning." >&2
  exit 1
fi

if [[ "$MCP_VALID_COUNT" -eq 1 && "$GITHUB_SECRET_EXISTS" == "true" ]]; then
  verify_public_dns "$MCP_VALID_CONTENT"
  echo "MCP Registry credential is already configured for ${DOMAIN} and ${REPO}; no key was generated and no state was changed."
  exit 0
fi
if [[ "$MCP_VALID_COUNT" -eq 1 && "$GITHUB_SECRET_EXISTS" == "false" ]]; then
  echo "ERROR: Partial MCP Registry credential state: a valid ownership TXT record exists at ${DOMAIN}, but ${SECRET_NAME} is missing from ${REPO}." >&2
  echo "ACTION: Restore the original matching private key as ${SECRET_NAME}, or remove only that MCP Registry TXT record and rerun to generate a new pair." >&2
  exit 1
fi
if [[ "$MCP_VALID_COUNT" -eq 0 && "$GITHUB_SECRET_EXISTS" == "true" ]]; then
  echo "ERROR: Partial MCP Registry credential state: ${SECRET_NAME} exists in ${REPO}, but no valid ownership TXT record exists at ${DOMAIN}." >&2
  echo "ACTION: Restore the matching public TXT proof if the private key is recoverable, or delete ${SECRET_NAME} and rerun to generate a new pair." >&2
  exit 1
fi

previous_umask="$(umask)"
umask 077
KEY_DIR="$(mktemp -d)"
umask "$previous_umask"
KEY_FILE="${KEY_DIR}/mcp-registry-ed25519.pem"
openssl genpkey -algorithm Ed25519 -out "$KEY_FILE" >/dev/null 2>&1

PUBLIC_KEY="$(openssl pkey -in "$KEY_FILE" -pubout -outform DER 2>/dev/null | tail -c 32 | base64)"
if ! PRIVATE_KEY="$(openssl pkey -in "$KEY_FILE" -outform DER 2>/dev/null | python3 -c '
import sys


def read_der_element(encoded: bytes, offset: int) -> tuple[int, bytes, int]:
    if offset + 2 > len(encoded):
        raise ValueError("truncated DER element")

    tag = encoded[offset]
    length = encoded[offset + 1]
    content_offset = offset + 2
    if length & 0x80:
        length_octets = length & 0x7f
        if length_octets == 0 or content_offset + length_octets > len(encoded):
            raise ValueError("invalid DER length")
        length = int.from_bytes(
            encoded[content_offset:content_offset + length_octets],
            byteorder="big",
        )
        content_offset += length_octets

    content_end = content_offset + length
    if content_end > len(encoded):
        raise ValueError("truncated DER content")
    return tag, encoded[content_offset:content_end], content_end


try:
    der = sys.stdin.buffer.read()
    outer_tag, private_key_info, outer_end = read_der_element(der, 0)
    version_tag, version, field_offset = read_der_element(private_key_info, 0)
    algorithm_tag, algorithm, field_offset = read_der_element(private_key_info, field_offset)
    private_key_tag, wrapped_seed, field_offset = read_der_element(private_key_info, field_offset)
    oid_tag, oid, algorithm_end = read_der_element(algorithm, 0)
    seed_tag, seed, seed_end = read_der_element(wrapped_seed, 0)
except ValueError:
    raise SystemExit(1)

is_ed25519_private_key = (
    outer_tag == 0x30
    and outer_end == len(der)
    and version_tag == 0x02
    and version == b"\x00"
    and algorithm_tag == 0x30
    and oid_tag == 0x06
    and oid == bytes.fromhex("2b6570")
    and algorithm_end == len(algorithm)
    and private_key_tag == 0x04
    and field_offset == len(private_key_info)
    and seed_tag == 0x04
    and seed_end == len(wrapped_seed)
    and len(seed) == 32
)
if not is_ed25519_private_key:
    raise SystemExit(1)
sys.stdout.write(seed.hex())
')"; then
  echo "ERROR: Failed to extract the Ed25519 private seed from its DER encoding." >&2
  exit 1
fi

if ! printf '%s' "$PUBLIC_KEY" | python3 -c '
import base64
import binascii
import sys

try:
    key = base64.b64decode(sys.stdin.read(), validate=True)
except (binascii.Error, ValueError):
    raise SystemExit(1)
raise SystemExit(0 if len(key) == 32 else 1)
'; then
  echo "ERROR: Failed to derive a valid 32-byte Ed25519 public key for the DNS ownership proof." >&2
  exit 1
fi
if [[ ! "$PRIVATE_KEY" =~ ^[0-9a-fA-F]{64}$ ]]; then
  echo "ERROR: Failed to derive the 64-character Ed25519 private key required by mcp-publisher." >&2
  exit 1
fi

TXT_CONTENT="v=MCPv1; k=ed25519; p=${PUBLIC_KEY}"
TXT_PAYLOAD="$(python3 -c '
import json
import sys

print(json.dumps({
    "type": "TXT",
    "name": sys.argv[1],
    "content": sys.argv[2],
    "ttl": 120,
}))
' "$DOMAIN" "$TXT_CONTENT")"

CREATE_STATUS=0
if cloudflare_api_request \
  "create MCP Registry ownership TXT record for ${DOMAIN}" \
  "POST" \
  "/zones/${CLOUDFLARE_ZONE_ID}/dns_records" \
  "$TXT_PAYLOAD" \
  "/zones/${CLOUDFLARE_ZONE_ID}/dns_records?type=TXT&name=${DOMAIN}&per_page=100" >/dev/null; then
  :
else
  CREATE_STATUS=$?
  if [[ "$CREATE_STATUS" -ne "$CLOUDFLARE_API_UNKNOWN_OUTCOME_STATUS" ]]; then
    exit "$CREATE_STATUS"
  fi
  echo "WARNING: Cloudflare returned an ambiguous TXT-create outcome; reconciling the complete root TXT state without sending another create request." >&2
fi

if reconcile_created_txt_record "$TXT_CONTENT"; then
  :
else
  reconciliation_status=$?
  if [[ "$CREATE_STATUS" -eq "$CLOUDFLARE_API_UNKNOWN_OUTCOME_STATUS" || "$reconciliation_status" -eq "$CLOUDFLARE_API_UNKNOWN_OUTCOME_STATUS" ]]; then
    echo "ACTION: Do not rerun immediately. Inspect the root TXT records in Cloudflare and resume only after the create outcome is known." >&2
  else
    echo "ACTION: Resolve only MCP Registry TXT conflicts at ${DOMAIN}; preserve unrelated TXT records." >&2
  fi
  exit "$reconciliation_status"
fi

if ! set_github_secret "$REPO" "$PRIVATE_KEY"; then
  POST_FAILURE_SECRETS_JSON="$(fetch_github_secrets "$REPO")"
  if github_secret_exists "$POST_FAILURE_SECRETS_JSON"; then
    echo "ERROR: ${SECRET_NAME} now exists after an unsuccessful GitHub CLI response, so its value cannot be proven." >&2
    echo "ACTION: Delete ${SECRET_NAME} and the matching MCP Registry TXT record, then rerun once the partial state is absent." >&2
  else
    post_failure_lookup_status=$?
    if [[ "$post_failure_lookup_status" -eq 1 ]]; then
      echo "ERROR: The ownership TXT record exists, but ${SECRET_NAME} was not created in ${REPO}." >&2
      echo "ACTION: Remove only the MCP Registry TXT record, then rerun to generate a new credential pair." >&2
    else
      echo "ERROR: GitHub secret state could not be proven after the failed update." >&2
      echo "ACTION: Inspect ${SECRET_NAME} in ${REPO} and the MCP Registry TXT record before rerunning." >&2
    fi
  fi
  exit 1
fi

FINAL_SECRETS_JSON="$(fetch_github_secrets "$REPO")"
if github_secret_exists "$FINAL_SECRETS_JSON"; then
  :
else
  final_lookup_status=$?
  if [[ "$final_lookup_status" -eq 1 ]]; then
    echo "ERROR: GitHub reported a successful secret update, but ${SECRET_NAME} is absent from ${REPO}." >&2
  else
    echo "ERROR: GitHub secret state could not be parsed after the successful update." >&2
  fi
  exit "$final_lookup_status"
fi

verify_public_dns "$TXT_CONTENT"

cleanup
trap - EXIT HUP INT TERM
echo "Created the MCP Registry ownership TXT record for ${DOMAIN} without changing unrelated TXT records."
echo "Stored ${SECRET_NAME} in ${REPO}."
echo "Temporary key material was removed without printing the private key."
echo "After this code is promoted to main, publish with:"
echo "  gh workflow run mcp-registry-publish.yml --repo ${REPO} --ref main"
