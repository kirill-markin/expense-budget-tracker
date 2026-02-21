# Deployment

## Local (Docker Compose)

### Prerequisites

- Docker and Docker Compose

### Start

```bash
make up
```

This runs `docker compose -f infra/docker/compose.yml up -d`, which starts:

1. **postgres** — Postgres 18 with health check.
2. **migrate** — init container that runs `scripts/migrate.sh` (all migrations + views).
3. **web** — Next.js app on `http://localhost:3000`.
4. **worker** — Python FX rate fetcher on a daily schedule.

### Demo mode

To preview dashboards without a database, set `DEMO_MODE=true` in the environment or click "Try Demo" in the topbar. Demo mode serves static sample data and discards all writes.

### Stop

```bash
make down
```

### Other commands

| Command | Description |
|---|---|
| `make dev` | Start in foreground (logs visible) |
| `make build` | Rebuild container images |
| `make test` | Run web + worker tests |
| `make lint` | Run web + worker linters |

## AWS (CDK)

Full AWS deployment guide is in [`infra/aws/README.md`](../infra/aws/README.md).

We recommend deploying into a **dedicated AWS account** (the AWS equivalent of a GCP project) for complete isolation of resources, billing, and IAM. See the "AWS account isolation" section in the AWS README for setup instructions.

Summary: CDK stack deploys VPC, EC2 (Docker Compose), RDS Postgres (private), ALB with Cognito auth, WAF, Lambda for FX fetchers, CloudWatch monitoring, S3 access logs, and optional Route 53 DNS.

```bash
cd infra/aws
npm install
cp cdk.context.local.example.json cdk.context.local.json
# edit cdk.context.local.json with your values
AWS_PROFILE=expense-tracker cdk bootstrap   # first time only
AWS_PROFILE=expense-tracker cdk deploy
```
