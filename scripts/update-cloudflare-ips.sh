#!/usr/bin/env bash
# Fetch current Cloudflare edge IP ranges and update infra/aws/cloudflare-ips.json.
#
# Run periodically (CI cron or manually) to keep the ALB security group in sync.
# If the file changes, commit and deploy to apply new rules.
#
# No env vars or credentials required — the Cloudflare /ips endpoint is public.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET="${SCRIPT_DIR}/../infra/aws/cloudflare-ips.json"

RESPONSE=$(curl -sf "https://api.cloudflare.com/client/v4/ips")

SUCCESS=$(echo "$RESPONSE" | python3 -c 'import sys,json; print(json.load(sys.stdin)["success"])')
if [[ "$SUCCESS" != "True" ]]; then
  echo "ERROR: Cloudflare API returned success=false" >&2
  echo "$RESPONSE" >&2
  exit 1
fi

echo "$RESPONSE" | python3 -c '
import sys, json

data = json.load(sys.stdin)["result"]
out = {"ipv4_cidrs": sorted(data["ipv4_cidrs"])}
print(json.dumps(out, indent=2))
' > "$TARGET"

echo "Updated $(wc -l < "$TARGET" | tr -d ' ') lines in cloudflare-ips.json"
