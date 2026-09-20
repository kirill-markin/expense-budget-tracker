# Deployment

## Local (Docker Compose)

### Prerequisites

- Docker and Docker Compose

### Start

```bash
make up
```

This runs `docker compose -f infra/docker/compose.yml up -d`. The compose file itself defaults to a local development stack (`AUTH_MODE=none`, `ALLOW_INSECURE_NO_AUTH=true`, `CORS_ORIGIN=http://localhost:3000`), so the stack is unauthenticated and published on loopback only; running `docker compose` directly behaves the same, since the make targets add no environment of their own. It starts:

1. **postgres** — Postgres 18 with health check.
2. **migrate** — init container that runs `scripts/migrate.sh` (all migrations + views).
3. **web** — Next.js app on `http://localhost:3000`.
4. **worker** — TypeScript FX rate fetcher on a daily schedule.

### Configuration

Copy [`infra/docker/.env.example`](../infra/docker/.env.example) to `infra/docker/.env` to change anything. Compose resolves each variable from the shell environment first, then that file, then the defaults in the compose file — written as `${VAR:-default}`, except `AUTH_MODE` and `ALLOW_INSECURE_NO_AUTH`, which use `${VAR-default}` so an explicit empty value is not replaced. Operator configuration wins over the development defaults for any non-empty value.

`AUTH_MODE=cognito` is not a supported configuration of this compose stack. That mode makes the web app require the `DB_HOST`/`DB_PASSWORD` pair (`apps/web/src/instrumentation.ts`), while the `web` service here wires `DATABASE_URL` instead; `infra/docker/.env` cannot supply the missing pair either, because Compose reads that file for variable interpolation and the service has no `env_file`. The authenticated deployment lives in AWS — see [`infra/aws/README.md`](../infra/aws/README.md). The standalone `auth` service is kept out of the default stack by the `cognito` profile because starting it requires real Cognito credentials, and doing so still does not give the web app an authenticated stack.

If you want Langfuse tracing in local Docker, set `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL`, and an explicit 64-character lowercase hexadecimal `LANGFUSE_RELEASE` together in `infra/docker/.env`. Leave the three connection values unset if you do not want telemetry; `LANGFUSE_RELEASE` alone does not enable it.

### Stop

```bash
make down
```

### Other commands

| Command | Description |
|---|---|
| `make dev` | Start in foreground (logs visible) |
| `make build` | Rebuild container images (not `auth`, which is in the `cognito` profile: use `COMPOSE_PROFILES=cognito make build`) |
| `make lint` | Run web + worker linters |

## AWS (CDK)

Full AWS deployment guide is in [`infra/aws/README.md`](../infra/aws/README.md).
Langfuse trace verification and troubleshooting are documented in [`docs/langfuse-operations.md`](./langfuse-operations.md).

We recommend deploying into a **dedicated AWS account** (the AWS equivalent of a GCP project) for complete isolation of resources, billing, and IAM. See step 1 in the AWS README for setup instructions.

Summary: CDK stack deploys VPC, ECS Fargate (web app), RDS Postgres (private), ALB with Cognito auth + Cloudflare Origin Certificate, WAF, Lambda for FX fetchers, CloudWatch monitoring, and S3 access logs. Docker images are built by CDK (via `fromAsset`) and pushed to the CDK bootstrap ECR repo. DNS is managed via Cloudflare (domain registration, CNAME to ALB, CDN, edge SSL). Open registration: anyone can sign up with email, each user gets an isolated workspace via RLS.

### Bootstrap and CI/CD

Both bootstrap and CI/CD use the same method: `cdk deploy`. CDK builds Docker images, pushes them to the bootstrap ECR repo, and creates/updates all infrastructure in one pass. The web task receives the deterministic hash of its exact CDK Docker image asset as `LANGFUSE_RELEASE`. `/api/live` is used only for ECS/ALB liveness. Database migrations run as a one-off ECS task after deploy, and `/api/health` is checked after deploy to confirm DB readiness.

**Bootstrap (first deploy, one-time):** `scripts/bootstrap.sh`

```bash
export AWS_PROFILE=expense-tracker
bash scripts/bootstrap.sh --region eu-central-1
```

The script runs `cdk bootstrap` (prepares the AWS account), then `cdk deploy` (creates everything), then runs database migrations, then checks `/api/health` through the ALB DNS name to confirm DB readiness, then invokes the FX fetcher Lambda to seed exchange rates. After the first deploy, set the OpenAI and Langfuse secrets in Secrets Manager and restart ECS — see step 7 in [`infra/aws/README.md`](../infra/aws/README.md#7-post-deploy).

**CI/CD (all subsequent deploys):** `.github/workflows/deploy.yml`

Triggered on every push to `main`. Runs the same `cdk deploy` to update infrastructure and images, then runs migrations when needed, then checks `https://app.<domain>/api/health` through Cloudflare to confirm DB readiness, then invokes the FX fetcher Lambda when worker code changes.

Schema changes in this pipeline must remain backward-compatible for at least one deploy. If a change requires “migrate before new web code serves traffic”, use a separate two-phase rollout instead of the default pipeline.

The chat runtime now keeps all conversation state in Postgres and the app process. OpenAI Conversations, hosted code interpreter containers, and provider-managed recovery are not part of the deployed architecture anymore. Existing environments must run migration `0032_chat_runtime_local_loop.sql` before relying on the new chat stack.

The current cutover includes tracing only. Dataset creation from Langfuse traces is not part of this runtime migration and remains phase 2 observability work.
