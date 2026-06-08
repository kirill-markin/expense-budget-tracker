# expense-budget-tracker

Open-source expense and budget tracker: expenses, budgets, balances, transfers, and multi-currency reporting on Postgres.

## Rules

- Use English for code comments and documentation.
- Prefer functional programming and pure functions.
- Use classes only for connectors to external systems.
- Use strict typing across functions, variables, and collections.
- Avoid fallback logic unless explicitly requested.
- Raise explicit, actionable errors with context.
- Machine API documentation is intentionally duplicated across the discovery envelope (`actions` and `instructions`) and the published specs (`/v1/openapi.json`, `/v1/swagger.json`, `api/openapi.yaml`). When changing the machine API, keep all of these in sync in the same change.
- Keep changes minimal and scoped to the current request.
- Before considering a large block of work complete, run the relevant type checks and builds, and for web changes a production build (`cd apps/web && npm run lint && npm run build`).
- Prefer non-interactive terminal commands.
- The web app supports multiple languages. When adding or changing any translation in `apps/web/src/i18n/`, update the same keys in every locale file in that directory in the same change.
- Change schema via new files in `db/migrations/` only; never edit already-applied migrations.
- CI/CD is GitHub Actions on push to `main` (`.github/workflows/deploy.yml`).
- The deploy process intentionally may update the web service before running migrations; this accepted deploy order is not an issue by itself.
- Do not build AWS SDK bundles or other AWS deployment artifacts locally. Push code to `main`, and let CI/CD build and deploy everything.
- RTL support is required:
  - In CSS, use logical properties such as `inset-inline-start`/`end`, `margin-inline-start`/`end`, `padding-inline-start`/`end`, `border-inline-start`/`end`, and `text-align: start`/`end` instead of physical left/right variants.
  - Use `[dir="rtl"]` overrides only when no logical equivalent exists (for example `box-shadow`).
  - In JS, account for RTL when handling `scrollLeft`, element positioning, and resize logic.

## Components

- `apps/web/`: Next.js app with UI dashboards and API routes for transactions, balances, budget, and FX data; SQL via `pg.Pool`. The web app also includes an AI chat where the user can open `/chat` and talk to their workspace data directly from the browser.
- `apps/worker/`: TypeScript process that fetches daily ECB, CBR, and NBS exchange rates into `exchange_rates`; runs on a schedule (Docker) or as AWS Lambda
- Postgres: single source of truth; schema in `db/migrations/`, views in `db/views/`, reference SQL in `db/queries/`

## Supported Clients

- AI agent flows are split into two separate surfaces: the web app has its own built-in chat with conversations, while external client agents use the public machine API, mainly through the slash SQL endpoint; the client list below is about the external/API flow for reference.
- Web app: supported
- Terminal / AI agents: full functionality is supported through the canonical machine API entrypoint `GET https://api.expense-budget-tracker.com/v1/` (the discovery response includes the next-step instructions for signup/login and email OTP onboarding)
- Direct HTTP clients and scripts: supported through the same `https://api.expense-budget-tracker.com/v1` surface with `Authorization: ApiKey <key>`

## Key Paths

| Path | Description |
| --- | --- |
| `apps/web/src/app/api/` | Next.js API routes (`budget-grid`, `transactions`, `balances-summary`, and others) |
| `apps/web/src/app/chat/page.tsx` | Web AI chat page at `/chat`; fullscreen browser entrypoint for chatting with workspace data |
| `apps/web/src/app/api/chat/route.ts` | Server API entrypoint for the web AI chat (`POST` stream, `DELETE` reset) |
| `apps/web/src/server/chat/openai/loop.ts` | Main app-managed OpenAI chat loop for the web app |
| `apps/web/src/server/` | Server-side data functions for budget, balances, and transactions |
| `apps/web/src/ui/` | React components: tables, charts, hooks |
| `apps/web/src/proxy.ts` | Auth proxy logic controlled by `AUTH_MODE` |
| `apps/worker/src/fetchers/` | FX rate fetchers: `ecb.ts`, `cbr.ts`, `nbs.ts` |
| `db/migrations/` | Postgres migrations applied in order by `scripts/migrate.sh` |
| `db/views/` | Postgres views such as `accounts` |
| `db/queries/` | Reference SQL: `balances.sql`, `budget_grid.sql`, `fx_breakdown.sql`, `transactions.sql` |
| `apps/web/src/server/apiKeys.ts` | API key generation, hashing, CRUD |
| `apps/web/src/app/api/api-keys/route.ts` | API key management endpoints (`GET`/`POST`/`DELETE`) |
| `apps/sql-api/` | SQL API Lambda handlers (authorizer + executor) for API Gateway |
| `apps/web/src/server/demo/data.ts` | Static demo data for demo mode without a DB |
| `apps/web/src/lib/demoMode.ts` | Demo mode check; enabled by `demo=true` browser cookie toggled in the UI, no env var needed |
| `infra/docker/compose.yml` | Local Docker Compose for Postgres, migrate, web, and worker |
| `infra/aws/` | AWS CDK stack for ECS Fargate, RDS, ALB/Cognito, API Gateway, Lambda, and WAF |
| `scripts/migrate.sh` | Runs migrations and views against `DATABASE_URL` |
| `.env.example` | Environment variable reference |

## Cloudflare

Cloudflare credentials are stored locally in `scripts/cloudflare/.env` (gitignored). Scripts in `scripts/cloudflare/` manage DNS, SSL, and cache rules via the Cloudflare API.

## AWS Deployment

Before querying AWS resources:
1. Read `infra/aws/cdk.context.local.json` for region, domain, certificate ARNs, and account-specific settings.
2. Check `~/.aws/config` for the CLI profile targeting the same account and region.
3. Always use matching `--profile` and `--region` flags.

- CDK context: `infra/aws/cdk.context.local.json`
- CDK stack name: `ExpenseBudgetTracker`
- CI/CD: on push to `main`, GitHub Actions deploys CDK, builds and pushes Docker images to ECR, runs the ECS migration task, and updates the ECS service. Secrets: `AWS_DEPLOY_ROLE_ARN`, `CDK_CONTEXT`

## Local Development

For UI work, run the Next.js dev server directly:

```bash
cd apps/web && npm run dev
```

For local browser tryouts, set local auth explicitly and make `CORS_ORIGIN` match the exact origin opened in the browser:

```bash
cd apps/web
AUTH_MODE=none CORS_ORIGIN=http://localhost:3000 npm run dev
```

If the browser uses another local host or port, set the same origin in `CORS_ORIGIN` and in the dev server command:

```bash
cd apps/web
AUTH_MODE=none CORS_ORIGIN=http://127.0.0.1:3001 npm run dev -- -H 127.0.0.1 -p 3001
```

Toggle Demo mode with the All/Demo button in the header. It sets a `demo=true` browser cookie and serves data from `apps/web/src/server/demo/data.ts` in memory, so no Postgres is required and code changes hot-reload immediately.

Use `make dev` (Docker Compose) only when you need a real database, such as for migrations, SQL queries, or the worker. Docker runs a production Next.js build, so each code change requires `docker compose -f infra/docker/compose.yml build web`.

## Logging

Use the structured server logger in `apps/web/src/server/logger.ts`. Log through `log()` only; never use raw `console.log` or `console.error`. Add new event types to the `LogEvent` union.
For CloudWatch investigations, avoid complex OR filter patterns. Fetch fresh events first, then filter locally by `requestId` and chat error signals.

## Reference

- [docs/architecture.md](docs/architecture.md) - system overview, data model, multi-currency design, auth model
- [docs/deployment.md](docs/deployment.md) - local Docker Compose and AWS CDK setup
- [infra/aws/README.md](infra/aws/README.md) - full AWS CDK deployment guide
- [Makefile](Makefile) - `make up`, `make down`, `make migrate`, `make build`, `make lint`
