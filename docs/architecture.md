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

Three components, one database:

1. **web** (`apps/web/`) — Next.js 16 app. Serves the UI and exposes API routes for transactions, balances, budget, and FX data. All SQL runs against Postgres via a shared `pg.Pool` with per-request RLS context.
2. **worker** (`apps/worker/`) — TypeScript process that fetches daily exchange rates from ECB, CBR, and NBS and inserts them into `exchange_rates`. Runs on a schedule (local Docker) or as a Lambda (AWS).
3. **Postgres** — single source of truth. Seven tables (six with RLS), one view.

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

### Three database roles

| Role | Used by | RLS | Purpose |
|---|---|---|---|
| `tracker` (owner) | `migrate.sh` only | Bypassed (table owner) | DDL, creates tables/policies/roles |
| `app` | Web app | Enforced | `SET LOCAL app.user_id` + `app.workspace_id` per transaction |
| `user_xxx` | Direct DB access | Enforced | `ALTER ROLE ... SET app.user_id` + `app.workspace_id` statically |

### How it works

1. **Web app**: proxy.ts extracts user identity (`AUTH_MODE=none` → `"local"`, `AUTH_MODE=proxy` → JWT `sub` claim) and forwards it as `x-user-id` and `x-workspace-id` headers.
2. **db.ts**: `queryAs(userId, workspaceId, sql, params)` wraps each query in `BEGIN` → `SET LOCAL app.user_id` → `SET LOCAL app.workspace_id` → query → `COMMIT`. RLS policies check workspace membership via `workspace_members` and filter by `workspace_id = current_setting('app.workspace_id')`.
3. **Direct access**: users get their own Postgres role with `ALTER ROLE user_xxx SET app.user_id TO 'cognito-sub'`. When `app.workspace_id` is not set, RLS allows access to all workspaces the user is a member of.

### RLS policy design

Each data table uses a dual-condition policy:
- **Security**: `workspace_id IN (SELECT wm.workspace_id FROM workspace_members wm WHERE wm.user_id = current_setting('app.user_id'))` — ensures the user is a member.
- **Performance**: `workspace_id = current_setting('app.workspace_id')` — narrows to the active workspace (skipped when `app.workspace_id` is NULL, for direct DB users).

### User provisioning (direct DB access)

Run as the `tracker` owner role:

```sql
CREATE ROLE user_alice LOGIN PASSWORD 'strong-random-password';
GRANT CONNECT ON DATABASE tracker TO user_alice;
GRANT USAGE ON SCHEMA public TO user_alice;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  ledger_entries, budget_lines, budget_comments, workspace_settings TO user_alice;
GRANT SELECT, INSERT ON TABLE workspaces, workspace_members TO user_alice;
GRANT SELECT ON TABLE exchange_rates TO user_alice;
ALTER ROLE user_alice SET app.user_id TO 'cognito-sub-uuid-here';
ALTER ROLE user_alice SET app.workspace_id TO 'workspace-id-here';
```

For read-only access (dashboards), grant only `SELECT`.

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
