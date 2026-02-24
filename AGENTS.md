# expense-budget-tracker

Open-source expense and budget tracker: expenses, budgets, balances, transfers, and multi-currency reporting on Postgres.

## Rules

- Use English for code comments and documentation.
- Prefer functional programming and pure functions.
- Use classes only for connectors to external systems.
- Use strict typing across functions, variables, and collections.
- Avoid fallback logic unless explicitly requested.
- Raise explicit, actionable errors with context.
- Keep changes minimal and scoped to the current request.
- Prefer non-interactive terminal commands.
- Schema changes via migrations only: add a new file in `db/migrations/`, do not edit already-applied migrations.
- CI/CD is GitHub Actions on push to `main` (`.github/workflows/deploy.yml`).

## Components

1. **web** (`apps/web/`) — Next.js app. UI dashboards and API routes for transactions, balances, budget, and FX data. SQL via `pg.Pool`.
2. **worker** (`apps/worker/`) — TypeScript process that fetches daily exchange rates from ECB, CBR, and NBS into `exchange_rates`. Runs on a schedule (Docker) or as a Lambda (AWS).
3. **Postgres** — single source of truth. Schema in `db/migrations/`, views in `db/views/`, reference queries in `db/queries/`.

## Key paths

| Path | Description |
|---|---|
| `apps/web/src/app/api/` | Next.js API routes (budget-grid, transactions, balances-summary, etc.) |
| `apps/web/src/server/` | Server-side data functions (budget, balances, transactions) |
| `apps/web/src/ui/` | React components: tables, charts, hooks |
| `apps/web/src/proxy.ts` | Auth proxy logic (`AUTH_MODE` env var) |
| `apps/worker/src/fetchers/` | FX rate fetchers: `ecb.ts`, `cbr.ts`, `nbs.ts` |
| `db/migrations/` | Postgres migrations (applied in order by `scripts/migrate.sh`) |
| `db/views/` | Postgres views (`accounts`) |
| `db/queries/` | Reference SQL: `balances.sql`, `budget_grid.sql`, `fx_breakdown.sql`, `transactions.sql` |
| `apps/web/src/server/demo/data.ts` | Static demo data for demo mode (no DB needed) |
| `infra/docker/compose.yml` | Local Docker Compose (Postgres + migrate + web + worker) |
| `infra/aws/` | AWS CDK stack (EC2, RDS, ALB/Cognito, Lambda, WAF) |
| `scripts/migrate.sh` | Runs all migrations + views against `DATABASE_URL` |
| `.env.example` | Environment variables reference |

## AWS deployment

Before querying AWS resources, read `infra/aws/cdk.context.local.json` first — it contains the region, domain, certificate ARNs, and all account-specific settings. Then check `~/.aws/config` for the AWS CLI profile that targets the same account and region. Always use the matching `--profile` and `--region` flags.

- **CDK context**: `infra/aws/cdk.context.local.json`
- **CDK stack name**: `ExpenseBudgetTracker`
- **CI/CD**: GitHub Actions on push to `main`, deploys CDK + updates EC2 via SSM. Secrets: `AWS_DEPLOY_ROLE_ARN`, `CDK_CONTEXT`

## Reference

- [docs/architecture.md](docs/architecture.md) — system overview, data model, multi-currency design, auth model
- [docs/deployment.md](docs/deployment.md) — local Docker Compose and AWS CDK setup
- [infra/aws/README.md](infra/aws/README.md) — full AWS CDK deployment guide
- [Makefile](Makefile) — `make up`, `make down`, `make migrate`, `make test`, `make lint`
