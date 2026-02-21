# Architecture

## System overview

```
┌─────────────┐     ┌────────────────────┐     ┌──────────────┐
│ Browser UI  │────▶│  Next.js (web)     │────▶│  Postgres 18 │
│             │◀────│  API routes + SSR  │◀────│              │
└─────────────┘     └────────────────────┘     └──────────────┘
                                                       ▲
                    ┌────────────────────┐             │
                    │  Worker (Python)   │─────────────┘
                    │  FX rate fetchers  │
                    └────────────────────┘
```

Three components, one database:

1. **web** (`apps/web/`) — Next.js 16 app. Serves the UI and exposes API routes for transactions, balances, budget, and FX data. All SQL runs against Postgres via a shared `pg.Pool`.
2. **worker** (`apps/worker/`) — Python process that fetches daily exchange rates from ECB, CBR, and NBS and inserts them into `exchange_rates`. Runs on a schedule (local Docker) or as a Lambda (AWS).
3. **Postgres** — single source of truth. Five tables, one view.

## Data model

```
ledger_entries          exchange_rates         budget_lines
─────────────           ──────────────         ────────────
entry_id (PK)           base_currency (PK)     id (PK)
event_id                quote_currency (PK)    budget_month
ts                      rate_date (PK)         direction
account_id              rate                   category
amount                                         kind (base|modifier)
currency                                       currency
kind (income|spend|                            planned_value
      transfer)                                inserted_at
category
counterparty            workspace_settings     budget_comments
note                    ──────────────────     ───────────────
                        id (PK, singleton)     id (PK)
accounts (VIEW)         reporting_currency     budget_month
──────────────                                 direction
derived from                                   category
ledger_entries                                 comment
                                               inserted_at
```

- `ledger_entries` — one row per account movement. Immutable except category/note.
- `exchange_rates` — one row per (base, quote, date) triple. Generalized: no USD assumption.
- `budget_lines` — append-only. Effective value resolved by latest `inserted_at` per cell.
- `budget_comments` — append-only. Same last-write-wins pattern.
- `workspace_settings` — singleton row storing the reporting currency.
- `accounts` — view derived from `ledger_entries` (no physical table).

## Multi-currency conversion

All amounts are stored in native currency only. No precomputed `amount_usd` column.

Conversion to the reporting currency happens at read time via SQL joins:

1. `exchange_rates` stores `(base_currency, quote_currency, rate_date, rate)`.
2. Queries build a `rate_ranges` CTE using `LEAD()` to find the applicable rate for any date.
3. The reporting currency is read from `workspace_settings` and passed as `$1` to all queries.
4. If no rate exists for a currency, the converted amount is NULL and a warning is returned.

## Auth model

Zero built-in auth logic. Two modes controlled by `AUTH_MODE` env var:

- `none` (default) — no authentication. App binds to `127.0.0.1` so only local access is possible.
- `proxy` — trusts a header set by a reverse proxy (ALB, Cloudflare Access, nginx, etc.). Returns 401 if the header is missing.

Details in `apps/web/src/proxy.ts`.

## Deployment profiles

1. **Local** — Docker Compose: Postgres + web + worker + migrate init container. See `docs/deployment.md`.
2. **AWS** — CDK stack: EC2 + RDS + ALB/Cognito + Lambda + WAF + monitoring. See `infra/aws/README.md`.
