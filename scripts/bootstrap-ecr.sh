#!/usr/bin/env bash
# First-time AWS deployment: bootstrap CDK, deploy infrastructure, build and
# push Docker images to ECR, redeploy so ECS picks them up.
#
# Run once after configuring cdk.context.local.json (step 4 in the README).
# After this, CI/CD handles all subsequent deploys on push to main.
#
# What it does:
#   1. CDK bootstrap (idempotent — safe to re-run)
#   2. CDK deploy (creates VPC, RDS, ECR, ECS, ALB, etc.)
#   3. Build and push web + migrate Docker images to ECR
#   4. CDK deploy again (ECS picks up the images)
#
# Required env vars:
#   AWS_PROFILE — AWS CLI profile for the target account
#
# Usage:
#   export AWS_PROFILE=expense-tracker
#   bash scripts/bootstrap-ecr.sh --region eu-central-1

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

# --- Step 1: CDK bootstrap (idempotent) ---
echo "=== CDK bootstrap ==="
cd "$CDK_DIR"
npm ci --silent
npx cdk bootstrap --region "$REGION"

# --- Step 2: First CDK deploy (creates ECR repos, ECS service with no images) ---
echo ""
echo "=== CDK deploy (infrastructure) ==="
npx cdk deploy --all --require-approval never

# --- Step 3: Read stack outputs ---
get_output() {
  aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" \
    --output text
}

WEB_REPO=$(get_output WebRepoUri)
MIGRATE_REPO=$(get_output MigrateRepoUri)
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

echo ""
echo "ECR web repo:     $WEB_REPO"
echo "ECR migrate repo: $MIGRATE_REPO"

# --- Step 4: Login to ECR, build and push images ---
echo ""
echo "=== Build and push Docker images ==="
aws ecr get-login-password --region "$REGION" | \
  docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

echo "Building web image..."
docker build -t "${WEB_REPO}:latest" "${ROOT_DIR}/apps/web"

echo "Building migrate image..."
docker build -t "${MIGRATE_REPO}:latest" -f "${ROOT_DIR}/infra/docker/Dockerfile.migrate" "${ROOT_DIR}"

echo "Pushing web image..."
docker push "${WEB_REPO}:latest"

echo "Pushing migrate image..."
docker push "${MIGRATE_REPO}:latest"

# --- Step 5: Redeploy so ECS picks up the images ---
echo ""
echo "=== CDK deploy (with images) ==="
npx cdk deploy --all --require-approval never

echo ""
echo "Bootstrap complete. ECS service should now be running."
echo "Next steps:"
echo "  1. Run scripts/cloudflare/setup-dns.sh to create DNS records (see README step 5)"
echo "  2. Configure CI/CD secrets in GitHub (see README section 'CI/CD')"
