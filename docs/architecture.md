# Architecture

## System overview

```
┌─────────────┐     ┌────────────────────┐     ┌──────────────┐
│ Browser UI  │────▶│  Next.js (web)     │────▶│  Postgres 18 │
│             │◀────│  API routes + SSR  │◀────│  (RLS)       │
└─────────────┘     └────────────────────┘     └──────────────┘
                                                     ▲
                    ┌────────────────────┐             │
                    │  Worker (TS)       │─────────────┘
                    │  FX rate fetchers  │
                    └────────────────────┘
```

Four components, one database:

1. **web** (`apps/web/`) — Next.js 16 app. Serves the UI and exposes API routes for transactions, balances, budget, and FX data. All SQL runs against Postgres via a shared `pg.Pool` with per-request RLS context.
2. **sql-api** (`apps/sql-api/`) — Two AWS Lambdas behind API Gateway (HTTP API) for machine clients. Lambda Authorizer validates `ebt_` Bearer tokens; SQL executor runs queries with RLS context. Separate from the web stack — no ALB involved.
3. **worker** (`apps/worker/`) — TypeScript process that fetches daily exchange rates from ECB, CBR, and NBS and inserts them into `exchange_rates`. Runs on a schedule (local Docker) or as a Lambda (AWS).
4. **Postgres** — single source of truth. Seven tables (six with RLS), one view.

## Data model

```
workspaces             workspace_members
──────────             ─────────────────
workspace_id (PK)      workspace_id (PK, FK)
name                   user_id (PK)
created_at

ledger_entries          exchange_rates         budget_lines
─────────────           ──────────────         ────────────
entry_id (PK)           base_currency (PK)     budget_month
workspace_id (RLS)      quote_currency (PK)    workspace_id (RLS)
event_id                rate_date (PK)         direction
ts                      rate                   category
account_id                                     kind (base|modifier)
amount                                         currency
currency                                       planned_value
kind (income|spend|                            inserted_at
      transfer)
category
counterparty            workspace_settings     budget_comments
note                    ──────────────────     ───────────────
                        workspace_id (PK,RLS)  budget_month
accounts (VIEW)         reporting_currency     workspace_id (RLS)
──────────────                                 direction
derived from                                   category
ledger_entries                                 comment
                                               inserted_at
```

- `workspaces` — one row per workspace. RLS: user sees only workspaces they belong to.
- `workspace_members` — (workspace_id, user_id) pairs. RLS: user sees only their own memberships.
- `ledger_entries` — one row per account movement. Immutable except category/note. RLS by `workspace_id`.
- `exchange_rates` — one row per (base, quote, date) triple. Generalized: no USD assumption. **No RLS** — global data.
- `budget_lines` — append-only. Effective value resolved by latest `inserted_at` per cell. RLS by `workspace_id`.
- `budget_comments` — append-only. Same last-write-wins pattern. RLS by `workspace_id`.
- `workspace_settings` — one row per workspace storing reporting currency. RLS by `workspace_id`.
- `accounts` — view derived from `ledger_entries` (inherits RLS automatically).

## Workspace-based isolation (RLS)

Data isolation using Postgres Row Level Security with workspace membership checks.

### Two database roles

| Role | Used by | RLS | Purpose |
|---|---|---|---|
| `tracker` (owner) | `migrate.sh` only | Bypassed (table owner) | DDL, creates tables/policies/roles |
| `app` | Web app | Enforced | `SET LOCAL app.user_id` + `app.workspace_id` per transaction |

### How it works

1. **Web app**: proxy.ts extracts user identity (`AUTH_MODE=none` → `"local"`, `AUTH_MODE=proxy` → JWT `sub` claim) and forwards it as `x-user-id` and `x-workspace-id` headers.
2. **db.ts**: `queryAs(userId, workspaceId, sql, params)` wraps each query in `BEGIN` → `SET LOCAL app.user_id` → `SET LOCAL app.workspace_id` → query → `COMMIT`. RLS policies check workspace membership via `workspace_members` and filter by `workspace_id = current_setting('app.workspace_id')`.

### RLS policy design

RLS policies check workspace membership via `app.user_id` and filter by `app.workspace_id`. Each data table has a PERMISSIVE policy that verifies the user is a member of the workspace and narrows to the active workspace.

### Programmatic access

For programmatic access (LLM agents, scripts, dashboards), generate an API key in Settings and use the SQL Query API endpoint.

## API Gateway (machine clients)

Machine clients (LLM agents, scripts, dashboards) use a separate path from the browser stack:

```
Machine: Cloudflare → API Gateway (REST API) → Lambda Authorizer → SQL Lambda → RDS
Browser: Cloudflare → ALB → Cognito → ECS (Next.js) → RDS
```

The SQL API runs on API Gateway (REST API) with its own domain (`api.example.com`), fully separate from the ALB. This provides per-key rate limiting via Usage Plans (10 req/s, 10k req/day per key), auth at the gateway (Lambda Authorizer with 5-min cache), CloudWatch metrics per endpoint, and a clean boundary for future machine-facing services.

### SQL Query API

```
curl / LLM agent
      │
      ▼
POST https://api.example.com/sql
Authorization: Bearer ebt_...
      │
      ▼
API Gateway → Lambda Authorizer (validates key, resolves identity)
      │
      ▼
SQL Lambda (sets RLS context, executes query)
      │
      ▼
Postgres (same app role + RLS as web app)
```

Users generate an API key in Settings, pass it as a Bearer token, and send SQL in a JSON body. Uses the same `app` role and RLS enforcement as the web application — `SET LOCAL app.user_id` and `app.workspace_id` per transaction.

### Security

| Concern | Mitigation |
|---|---|
| Key storage | SHA-256 hash only, plaintext never stored |
| Workspace isolation | Same RLS via `SET LOCAL` as all other routes |
| SQL injection / DDL | Keyword whitelist: only SELECT/WITH/INSERT/UPDATE/DELETE |
| Resource exhaustion | `statement_timeout = 30s`, 100-row limit, per-key throttling (10 req/s, 10k/day via Usage Plans) |
| Auth caching | 5-min TTL by Authorization header — repeated requests skip Lambda + DB |
| Stale keys | `last_used_at` tracking, manual revocation |
| Member removal | Auto-revoke trigger deletes all keys for removed user |

### Usage

```bash
curl -X POST https://api.example.com/sql \
  -H "Authorization: Bearer ebt_a7Bk9mNpQ2xR4wYz1cDfGhJvLs8tUeWi5o..." \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT * FROM ledger_entries ORDER BY ts DESC LIMIT 10"}'
```

## Multi-currency conversion

All amounts are stored in native currency only. No precomputed `amount_usd` column.

Conversion to the reporting currency happens at read time via SQL joins:

1. `exchange_rates` stores `(base_currency, quote_currency, rate_date, rate)`.
2. Queries build a `rate_ranges` CTE using `LEAD()` to find the applicable rate for any date.
3. The reporting currency is read from `workspace_settings` (per workspace) and passed as `$1` to all queries.
4. If no rate exists for a currency, the converted amount is NULL and a warning is returned.

## Auth model

Zero built-in auth logic. Two modes controlled by `AUTH_MODE` env var:

- `none` (default) — no authentication. App binds to `127.0.0.1`, userId is hardcoded to `"local"`, workspaceId is `"local"`. All data belongs to this single workspace.
- `proxy` — trusts a JWT header set by the reverse proxy (ALB + Cognito). Extracts `sub` claim as userId. In v1, workspaceId = userId (each user has a default workspace matching their user ID). Returns 401 if the header is missing or malformed. Open registration: anyone can sign up via Cognito — each user gets an isolated workspace via RLS.

Details in `apps/web/src/proxy.ts`.

## Deployment profiles

1. **Local** — Docker Compose: Postgres + web + worker + migrate init container. See `docs/deployment.md`.
2. **AWS** — CDK stack: ECS Fargate + RDS + ALB/Cognito + Lambda + WAF + monitoring. Images built in CI, pushed to ECR. The root domain (`domain.com`) redirects to `app.domain.com` via ALB rule. To serve your own site on the root domain, deploy it independently and point DNS there. See `infra/aws/README.md`.
