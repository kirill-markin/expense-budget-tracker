#!/usr/bin/env bash
# First-time AWS deployment: bootstrap CDK and deploy all infrastructure.
#
# Run once after configuring cdk.context.local.json (step 4 in the README).
# After this, CI/CD handles all subsequent deploys on push to main.
#
# Both bootstrap and CI/CD use the same method: `cdk deploy`.
# CDK builds Docker images, pushes them to the bootstrap ECR repo, and creates
# all resources (ECS, RDS, ALB, etc.) in a single command.
# /api/live is used only for infrastructure health checks. Migrations are run
# via a one-off ECS task after the deploy, then /api/health confirms DB readiness.
# Exchange rates are seeded by invoking the FX fetcher Lambda.
#
# Required env vars:
#   AWS_PROFILE — AWS CLI profile for the target account
#
# Usage:
#   export AWS_PROFILE=expense-tracker
#   bash scripts/bootstrap.sh --region eu-central-1

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CDK_DIR="${ROOT_DIR}/infra/aws"

# --- Parse arguments ---
REGION=""
STACK_NAME="ExpenseBudgetTracker"
while [[ $# -gt 0 ]]; do
  case $1 in
    --region) REGION="$2"; shift 2 ;;
    --stack-name) STACK_NAME="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$REGION" ]]; then
  echo "Usage: $0 --region <aws-region>" >&2
  exit 1
fi

if [[ ! -f "${CDK_DIR}/cdk.context.local.json" ]]; then
  echo "ERROR: ${CDK_DIR}/cdk.context.local.json not found." >&2
  echo "Copy cdk.context.local.example.json and fill in your values (see README step 4)." >&2
  exit 1
fi

# --- Step 1: Install dependencies ---
echo "=== Install dependencies ==="
cd "$ROOT_DIR"
npm ci --silent
cd "$CDK_DIR"

# --- Step 2: CDK bootstrap (idempotent) ---
echo ""
echo "=== CDK bootstrap ==="
npx cdk bootstrap --region "$REGION"

# --- Step 3: CDK deploy ---
# CDK builds Docker images (via fromAsset), pushes them to the bootstrap ECR repo,
# and creates all infrastructure in one pass. No chicken-and-egg problem.
echo ""
echo "=== CDK deploy ==="
npx cdk deploy --all --require-approval never

# --- Step 4: Read stack outputs ---
get_output() {
  aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" \
    --output text
}

CLUSTER=$(get_output EcsClusterName)
SERVICE=$(get_output EcsServiceName)
MIGRATE_TASK=$(get_output MigrateTaskDefArn)
MIGRATE_SG=$(get_output MigrateSecurityGroupId)
ALB_DNS=$(get_output AlbDns)

# --- Step 5: Run database migrations ---
echo ""
echo "=== Run database migrations ==="
CLUSTER="$CLUSTER" SERVICE="$SERVICE" MIGRATE_TASK="$MIGRATE_TASK" MIGRATE_SG="$MIGRATE_SG" \
  AWS_REGION="$REGION" \
  bash "${SCRIPT_DIR}/run-migration-task.sh"

# --- Step 6: Confirm web readiness ---
echo ""
echo "=== Confirm web readiness ==="
ALB_DNS="$ALB_DNS" bash "${SCRIPT_DIR}/check-web-readiness.sh"

# --- Step 7: Seed exchange rates ---
# Invoke the FX fetcher Lambda so the currency dropdown is populated immediately
# instead of waiting for the next scheduled run (08:00 UTC).
echo ""
echo "=== Seed exchange rates ==="
FX_FUNCTION=$(get_output FxFetcherFunctionName)
FX_FUNCTION="$FX_FUNCTION" AWS_REGION="$REGION" \
  bash "${SCRIPT_DIR}/invoke-fx-fetcher.sh" || \
  echo "WARNING: FX seeding failed (rates will sync on next scheduled run)" >&2

echo ""
echo "=== Bootstrap complete ==="
echo "ECS service is live. Database readiness confirmed. Exchange rates seeded."
echo ""
echo "Next steps:"
echo "  1. Run scripts/cloudflare/setup-dns.sh to create DNS records (see README step 5)"
echo "  2. Configure CI/CD secrets in GitHub (see README section 'CI/CD')"
