#!/usr/bin/env bash
# First-time AWS deployment: bootstrap CDK, deploy infrastructure, build and
# push Docker images to ECR, redeploy so ECS picks them up.
#
# Run once after configuring cdk.context.local.json (step 4 in the README).
# After this, CI/CD handles all subsequent deploys on push to main.
#
# What it does:
#   1. CDK bootstrap (idempotent — safe to re-run)
#   2. CDK deploy with desiredCount=0 (creates all resources; ECS service has
#      no tasks so CloudFormation doesn't hang waiting for missing images)
#   3. Build and push web + migrate Docker images to ECR
#   4. CDK deploy again with desiredCount=1 (ECS starts tasks with the images)
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

# --- Step 0: Install dependencies ---
echo "=== Install dependencies ==="
cd "$ROOT_DIR"
npm ci --silent --prefix apps/worker
cd "$CDK_DIR"
npm ci --silent

# --- Step 1: CDK bootstrap (idempotent) ---
echo "=== CDK bootstrap ==="
npx cdk bootstrap --region "$REGION"

# --- Step 2: CDK deploy with desiredCount=0 ---
# ECR repos are empty at this point. desiredCount=0 means CloudFormation
# creates the ECS service with 0 tasks, so it reaches steady state immediately
# and doesn't hang waiting for images that don't exist yet.
echo ""
echo "=== CDK deploy (infrastructure, no tasks) ==="
npx cdk deploy --all --require-approval never -c desiredCount=0

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

echo "Building web image (linux/arm64)..."
docker build --platform linux/arm64 -t "${WEB_REPO}:latest" "${ROOT_DIR}/apps/web"

echo "Building migrate image (linux/arm64)..."
docker build --platform linux/arm64 -t "${MIGRATE_REPO}:latest" -f "${ROOT_DIR}/infra/docker/Dockerfile.migrate" "${ROOT_DIR}"

echo "Pushing web image..."
docker push "${WEB_REPO}:latest"

echo "Pushing migrate image..."
docker push "${MIGRATE_REPO}:latest"

# --- Step 5: CDK deploy with desiredCount=1 (default) ---
# Images are now in ECR. This deploy updates the service to desiredCount=1,
# ECS starts tasks and pulls the images successfully.
echo ""
echo "=== CDK deploy (start service) ==="
npx cdk deploy --all --require-approval never

echo ""
echo "Bootstrap complete. ECS service should now be running."
echo "Next steps:"
echo "  1. Run scripts/cloudflare/setup-dns.sh to create DNS records (see README step 5)"
echo "  2. Configure CI/CD secrets in GitHub (see README section 'CI/CD')"
