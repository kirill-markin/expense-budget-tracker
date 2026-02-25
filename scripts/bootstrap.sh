#!/usr/bin/env bash
# First-time AWS deployment: bootstrap CDK and deploy all infrastructure.
#
# Run once after configuring cdk.context.local.json (step 4 in the README).
# After this, CI/CD handles all subsequent deploys on push to main.
#
# Both bootstrap and CI/CD use the same method: `cdk deploy`.
# CDK builds Docker images, pushes them to the bootstrap ECR repo, and creates
# all resources (ECS, RDS, ALB, etc.) in a single command.
# Migrations are run via a one-off ECS task after the deploy.
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
npm ci --silent --prefix apps/worker
cd "$CDK_DIR"
npm ci --silent

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

# --- Step 5: Run database migrations ---
echo ""
echo "=== Run database migrations ==="
CLUSTER="$CLUSTER" SERVICE="$SERVICE" MIGRATE_TASK="$MIGRATE_TASK" MIGRATE_SG="$MIGRATE_SG" \
  AWS_REGION="$REGION" \
  bash "${SCRIPT_DIR}/run-migration-task.sh"

# --- Step 6: Seed exchange rates ---
# Invoke the FX fetcher Lambda so the currency dropdown is populated immediately
# instead of waiting for the next scheduled run (08:00 UTC).
echo ""
echo "=== Seed exchange rates ==="
FX_FUNCTION=$(get_output FxFetcherFunctionName)
aws lambda invoke \
  --function-name "$FX_FUNCTION" \
  --region "$REGION" \
  --cli-read-timeout 300 \
  /dev/null
echo "Exchange rates seeded."

echo ""
echo "=== Bootstrap complete ==="
echo "ECS service is running. Database migrations applied. Exchange rates seeded."
echo ""
echo "Next steps:"
echo "  1. Run scripts/cloudflare/setup-dns.sh to create DNS records (see README step 5)"
echo "  2. Configure CI/CD secrets in GitHub (see README section 'CI/CD')"
