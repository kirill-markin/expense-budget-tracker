#!/usr/bin/env bash
# Run a one-off ECS Fargate migration task and wait for it to finish.
#
# Used by both bootstrap.sh (first deploy) and CI/CD (deploy.yml).
#
# Required env vars:
#   CLUSTER     — ECS cluster name
#   SERVICE     — ECS service name (to read subnet config)
#   MIGRATE_TASK — ECS task definition ARN for migrations
#   MIGRATE_SG  — Security group ID for the migration task
#
# Optional env vars:
#   AWS_REGION  — AWS region (passed as --region if set)

set -euo pipefail

: "${CLUSTER:?CLUSTER env var is required}"
: "${SERVICE:?SERVICE env var is required}"
: "${MIGRATE_TASK:?MIGRATE_TASK env var is required}"
: "${MIGRATE_SG:?MIGRATE_SG env var is required}"

REGION_FLAG=()
if [[ -n "${AWS_REGION:-}" ]]; then
  REGION_FLAG=(--region "$AWS_REGION")
fi

SUBNETS=$(aws ecs describe-services \
  "${REGION_FLAG[@]}" \
  --cluster "$CLUSTER" \
  --services "$SERVICE" \
  --query "services[0].networkConfiguration.awsvpcConfiguration.subnets" \
  --output text | tr '\t' ',')

TASK_ARN=$(aws ecs run-task \
  "${REGION_FLAG[@]}" \
  --cluster "$CLUSTER" \
  --task-definition "$MIGRATE_TASK" \
  --launch-type FARGATE \
  --platform-version LATEST \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$MIGRATE_SG],assignPublicIp=DISABLED}" \
  --query "tasks[0].taskArn" \
  --output text)

echo "Migration task: $TASK_ARN"

aws ecs wait tasks-stopped \
  "${REGION_FLAG[@]}" \
  --cluster "$CLUSTER" \
  --tasks "$TASK_ARN"

EXIT_CODE=$(aws ecs describe-tasks \
  "${REGION_FLAG[@]}" \
  --cluster "$CLUSTER" \
  --tasks "$TASK_ARN" \
  --query "tasks[0].containers[0].exitCode" \
  --output text)

if [ "$EXIT_CODE" != "0" ]; then
  echo "ERROR: Migration task failed with exit code $EXIT_CODE" >&2
  echo "Check CloudWatch logs at /expense-tracker/migrate" >&2
  exit 1
fi

echo "Migrations completed successfully."
