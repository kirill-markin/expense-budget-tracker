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
3. **Postgres** — single source of truth. Five tables (four with RLS), one view.

## Data model

```
ledger_entries          exchange_rates         budget_lines
─────────────           ──────────────         ────────────
entry_id (PK)           base_currency (PK)     budget_month
user_id (RLS)           quote_currency (PK)    user_id (RLS)
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
                        user_id (PK, RLS)      budget_month
accounts (VIEW)         reporting_currency     user_id (RLS)
──────────────                                 direction
derived from                                   category
ledger_entries                                 comment
                                               inserted_at
```

- `ledger_entries` — one row per account movement. Immutable except category/note. RLS by `user_id`.
- `exchange_rates` — one row per (base, quote, date) triple. Generalized: no USD assumption. **No RLS** — global data.
- `budget_lines` — append-only. Effective value resolved by latest `inserted_at` per cell. RLS by `user_id`.
- `budget_comments` — append-only. Same last-write-wins pattern. RLS by `user_id`.
- `workspace_settings` — one row per user storing reporting currency. RLS by `user_id`.
- `accounts` — view derived from `ledger_entries` (inherits RLS automatically).

## Multi-user isolation (RLS)

Per-user data isolation using Postgres Row Level Security.

### Three database roles

| Role | Used by | RLS | Purpose |
|---|---|---|---|
| `tracker` (owner) | `migrate.sh` only | Bypassed (table owner) | DDL, creates tables/policies/roles |
| `app` | Web app | Enforced | `SET LOCAL app.user_id` per transaction |
| `user_xxx` | Direct DB access | Enforced | `ALTER ROLE ... SET app.user_id` statically |

### How it works

1. **Web app**: proxy.ts extracts user identity (`AUTH_MODE=none` → `"local"`, `AUTH_MODE=proxy` → JWT `sub` claim) and forwards it as `x-user-id` header.
2. **db.ts**: `queryAs(userId, sql, params)` wraps each query in `BEGIN` → `SET LOCAL app.user_id` → query → `COMMIT`. RLS policies filter rows where `user_id = current_setting('app.user_id')`.
3. **Direct access**: users get their own Postgres role with `ALTER ROLE user_xxx SET app.user_id TO 'cognito-sub'`. Any SQL client (psql, Metabase, Grafana) sees only their data automatically.

### User provisioning (direct DB access)

Run as the `tracker` owner role:

```sql
CREATE ROLE user_alice LOGIN PASSWORD 'strong-random-password';
GRANT CONNECT ON DATABASE tracker TO user_alice;
GRANT USAGE ON SCHEMA public TO user_alice;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  ledger_entries, budget_lines, budget_comments, workspace_settings TO user_alice;
GRANT SELECT ON TABLE exchange_rates TO user_alice;
ALTER ROLE user_alice SET app.user_id TO 'cognito-sub-uuid-here';
```

For read-only access (dashboards), grant only `SELECT`.

## Multi-currency conversion

All amounts are stored in native currency only. No precomputed `amount_usd` column.

Conversion to the reporting currency happens at read time via SQL joins:

1. `exchange_rates` stores `(base_currency, quote_currency, rate_date, rate)`.
2. Queries build a `rate_ranges` CTE using `LEAD()` to find the applicable rate for any date.
3. The reporting currency is read from `workspace_settings` (per user) and passed as `$1` to all queries.
4. If no rate exists for a currency, the converted amount is NULL and a warning is returned.

## Auth model

Zero built-in auth logic. Two modes controlled by `AUTH_MODE` env var:

- `none` (default) — no authentication. App binds to `127.0.0.1`, userId is hardcoded to `"local"`. All data belongs to this single user.
- `proxy` — trusts a JWT header set by a reverse proxy (ALB + Cognito, Cloudflare Access, etc.). Extracts `sub` claim as userId. Returns 401 if the header is missing or malformed.

Details in `apps/web/src/proxy.ts`.

## Deployment profiles

1. **Local** — Docker Compose: Postgres + web + worker + migrate init container. See `docs/deployment.md`.
2. **AWS** — CDK stack: EC2 + RDS + ALB/Cognito + Lambda + WAF + monitoring. See `infra/aws/README.md`.
