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
4. **worker** — TypeScript FX rate fetcher on a daily schedule.

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

We recommend deploying into a **dedicated AWS account** (the AWS equivalent of a GCP project) for complete isolation of resources, billing, and IAM. See step 1 in the AWS README for setup instructions.

Summary: CDK stack deploys VPC, ECS Fargate (web app), RDS Postgres (private), ALB with Cognito auth + Cloudflare Origin Certificate, WAF, Lambda for FX fetchers, CloudWatch monitoring, and S3 access logs. Docker images are built by CDK (via `fromAsset`) and pushed to the CDK bootstrap ECR repo. DNS is managed via Cloudflare (domain registration, CNAME to ALB, CDN, edge SSL). Open registration: anyone can sign up with email, each user gets an isolated workspace via RLS.

### Bootstrap and CI/CD

Both bootstrap and CI/CD use the same method: `cdk deploy`. CDK builds Docker images, pushes them to the bootstrap ECR repo, and creates/updates all infrastructure in one pass. Migrations run as a one-off ECS task after deploy.

**Bootstrap (first deploy, one-time):** `scripts/bootstrap.sh`

```bash
export AWS_PROFILE=expense-tracker
bash scripts/bootstrap.sh --region eu-central-1
```

The script runs `cdk bootstrap` (prepares the AWS account) then `cdk deploy` (creates everything), then runs database migrations, then invokes the FX fetcher Lambda to seed exchange rates. After the first deploy, set AI API keys in Secrets Manager and restart ECS — see step 6.4 in [`infra/aws/README.md`](../infra/aws/README.md#6-post-deploy).

**CI/CD (all subsequent deploys):** `.github/workflows/deploy.yml`

Triggered on every push to `main`. Runs the same `cdk deploy` to update infrastructure and images, then runs migrations, then invokes the FX fetcher Lambda to ensure exchange rates are up to date.
