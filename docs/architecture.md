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
2. **sql-api** (`apps/sql-api/`) — Three AWS Lambdas: the `ApiKey` authorizer and v1 machine handler use the existing API Gateway REST API, while the dedicated OAuth-authenticated MCP handler uses a separate API Gateway HTTP API v2 at `mcp.*`. Separate from the web stack — no ALB involved.
3. **worker** (`apps/worker/`) — TypeScript process that fetches daily raw exchange rates from ECB, CBR, NBS, NBU, KuCoin, and USDT, stores them in `fx_rates_raw`, and rebuilds query-ready all-pairs daily rates in `fx_rates_daily`. Runs on a schedule (local Docker) or as a Lambda (AWS).
4. **Postgres** — single source of truth with workspace-scoped RLS and derived reporting views.

## Data model

```
workspaces             workspace_members
──────────             ─────────────────
workspace_id (PK)      workspace_id (PK, FK)
name                   user_id (PK)
created_at

ledger_entries          fx_rates_raw           budget_lines
─────────────           ────────────           ────────────
entry_id (PK)           base_currency (PK)     budget_month
workspace_id (RLS)      quote_currency (PK)    workspace_id (RLS)
event_id                rate_date (PK)         direction
ts                      rate                   category
account_id              source                 line_id (PK)
amount                  inserted_at            currency
currency                                       planned_value
kind (income|spend|                            inserted_at
      transfer)
category                fx_rates_daily         workspace_settings
counterparty            ─────────────          ──────────────────
note                    base_currency (PK)     workspace_id (PK,RLS)
                        quote_currency (PK)    reporting_currency
accounts (VIEW)         calendar_date (PK)
──────────────          rate                   budget_adjustments
derived from            source_rate_date       ──────────────────
ledger_entries          inserted_at            adjustment_id (PK)
                                               workspace_id (RLS)
                                               budget_month
                                               direction
                                               category
                                               amount
                                               note
                                               created_at
                                               updated_at
```

- `workspaces` — one row per workspace. RLS: user sees only workspaces they belong to.
- `workspace_members` — (workspace_id, user_id) pairs. RLS: user sees only their own memberships.
- `ledger_entries` — one row per account movement. Immutable except category/note. RLS by `workspace_id`.
- `fx_rates_raw` — canonical FX source-of-truth. One row per `(base, USD, rate_date)` triple plus source metadata. **No RLS** — global data.
- `fx_rates_daily` — query-ready daily all-pairs FX read model. One row per `(base, quote, calendar_date)` triple. **No RLS** — global data.
- `budget_lines` — Base plan rows, one row per `(budget_month, direction, category)` cell, enforced by a unique index. A CHECK forbids a zero `planned_value`, so a cleared cell has no row. RLS by `workspace_id`.
- `budget_adjustments` — normalized adjustment rows with optional row notes. Budget reads sum adjustments per cell. RLS by `workspace_id`. `api_sql_executor` can INSERT, UPDATE, and DELETE the user-editable columns, while `api_sql_reader` stays SELECT-only; the generated `adjustment_id`, `created_at`, and `updated_at` are not writable, and the internal `origin` marker stays outside every agent grant, so agent rows keep the `user` default.
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

1. **Web app**: proxy.ts extracts user identity (`AUTH_MODE=none` only for explicit local dev/test → `"local"`, `AUTH_MODE=cognito` → JWT `sub` claim from `session` cookie) and forwards it as `x-user-id` and `x-workspace-id` headers.
2. **db.ts**: `queryAs(userId, workspaceId, sql, params)` wraps each query in `BEGIN` → `SET LOCAL app.user_id` → `SET LOCAL app.workspace_id` → query → `COMMIT`. RLS policies check workspace membership via `workspace_members` and filter by `workspace_id = current_setting('app.workspace_id')`.

### RLS policy design

RLS policies check workspace membership via `app.user_id` and filter by `app.workspace_id`. Each data table has a PERMISSIVE policy that verifies the user is a member of the workspace and narrows to the active workspace.

### Programmatic access

For programmatic access (LLM agents, scripts, dashboards), start from `GET /v1/`, complete email OTP onboarding, and use the returned agent `ApiKey`.

## API Gateway (machine clients)

Machine clients (LLM agents, scripts, dashboards) use a separate path from the browser stack:

```
Machine: Cloudflare → API Gateway (REST API) → Lambda Authorizer → SQL Lambda → RDS
MCP: Cloudflare → dedicated API Gateway (HTTP API v2) → MCP Lambda → RDS
Browser: Cloudflare → ALB → ECS (Next.js, Cognito Email OTP) → RDS
```

The SQL API runs on API Gateway (REST API) with its own domain (`api.example.com`), fully separate from the ALB. This provides per-key rate limiting via Usage Plans (10 req/s, 10k req/day per key), auth at the gateway (the Lambda Authorizer runs on every request), CloudWatch metrics per endpoint, and a clean boundary for future machine-facing services. Revoked API keys take effect immediately.

The stateless MCP transport runs independently at `https://mcp.example.com/mcp` on an HTTP API v2 exposing only `GET /mcp`, `POST /mcp`, and the pathful protected-resource metadata route `GET /.well-known/oauth-protected-resource/mcp`. Its default `execute-api` endpoint is disabled, so Cloudflare and the root-mapped regional custom domain are the only public ingress. The stage permits a burst of 10 and then 5 requests/second, while 20 reserved MCP Lambda executions absorb short legitimate spikes without any provisioned-concurrency charge. Database concurrency is bounded independently by the explicit one-connection SQL API pool ceiling per execution environment: at most 20 of the database's approximately 85 connections, leaving about 65 for other workloads. OAuth remains on the existing `auth.*` ECS service behind the ALB. AWS WAF approximately rate-limits anonymous dynamic client registration at the exact `POST /oauth/register` route with a 10-request threshold over a 60-second evaluation window per real client IP from Cloudflare's trusted `CF-Connecting-IP` header.

### SQL Query API

```
curl / LLM agent
      │
      ▼
GET https://api.example.com/v1/
Authorization: none
...
POST https://api.example.com/v1/sql/query
Authorization: ApiKey ebta_...
X-Workspace-Id: workspace-id
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

Agents start from `GET /v1/`, complete email OTP on `auth.*`, store the returned ApiKey, load `/v1/me`, list or create `/v1/workspaces`, optionally inspect `/v1/schema`, select a workspace via `/v1/workspaces/{workspaceId}/select`, and use `/v1/sql/query` for readonly statements or `/v1/sql/execute` for one approved mutation. `/v1/sql` remains compatibility-only for atomic multi-statement scripts. `X-Workspace-Id` works on all three endpoints for explicit overrides, but is optional after a workspace is selected for that API key. The SQL execution path applies the same RLS enforcement as the web application — the pooled `app` role sets `SET LOCAL app.user_id` and `app.workspace_id` per transaction, then `SET LOCAL ROLE` narrows that connection for the user statement: `api_sql_reader` on `/v1/sql/query`, `api_sql_executor` on `/v1/sql/execute`, and `api_sql_executor` for the whole script on the compatibility-only `/v1/sql`.

### Security

| Concern | Mitigation |
|---|---|
| Key storage | SHA-256 hash only, plaintext never stored |
| Workspace isolation | Same RLS via `SET LOCAL` as all other routes |
| SQL injection / DDL | Keyword whitelist: only SELECT/WITH/INSERT/UPDATE/DELETE |
| Resource exhaustion | one 25-second total SQL request deadline, 100-row limit, per-key throttling (10 req/s, 10k/day via Usage Plans) |
| Auth caching | Disabled (0-second TTL) — every request invokes the authorizer and revoked keys take effect immediately |
| Stale keys | `last_used_at` tracking, manual revocation |
| Member removal | Auto-revoke trigger deletes all keys for removed user |

### Usage

```bash
curl -X POST https://api.example.com/v1/sql/query \
  -H "Authorization: ApiKey ebta_ABCD1234_0123456789ABCDEFGHJKMNPQRS" \
  -H "X-Workspace-Id: workspace-id" \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT * FROM ledger_entries ORDER BY ts DESC LIMIT 10"}'

curl -X POST https://api.example.com/v1/sql/execute \
  -H "Authorization: ApiKey ebta_ABCD1234_0123456789ABCDEFGHJKMNPQRS" \
  -H "X-Workspace-Id: workspace-id" \
  -H "Content-Type: application/json" \
  -d '{"sql": "DELETE FROM budget_lines WHERE planned_value = 0"}'
```

`X-Workspace-Id` is optional if the same API key has already called `POST /v1/workspaces/{workspaceId}/select`. If no workspace is saved and exactly one workspace exists for the user, the API auto-saves and uses that workspace for the key.

## Agent tools

`packages/agent-shared/src/agentTools.ts` is the single transport-neutral catalog of the five agent tools: `list_workspaces`, `get_schema`, `get_guide`, `sql_query`, and `sql_execute`. Both agent surfaces render their own tool definitions from that catalog instead of keeping private literals — the MCP server in `apps/sql-api/src/mcp/server.ts` and the web chat in `apps/web/src/server/chat/openai/tooling/tools.ts` — and both emit the shared result envelope from `packages/agent-shared/src/agentResults.ts`. A model therefore reads the same tools and the same result contract whether it reached the workspace over MCP or through the browser chat.

A surface profile records the little that each surface narrows: how a workspace is selected, whether a call carries one statement or a script, and which tool names the rendered text points at. The MCP server uses the catalog's own profile, where the caller passes a `workspaceId` returned by `list_workspaces` and may omit it only when exactly one workspace is available. The web chat differs in the workspace default alone: it resolves an omitted `workspaceId` to the workspace the browser session currently has open, so an explicit one is needed only to act on another accessible workspace.

- `get_schema` returns the allowed relations, their columns, and the per-relation hints from `getAgentSchemaHints`, together with the row, result-size, and statement-timeout limits.
- `get_guide` returns one of three topics: `sql_dialect` for the restricted SQL rules, `writing_data` for the write protocol, and `query_recipes` for the canonical read queries.
- `sql_query` runs in a repeatable-read, read-only transaction under the `api_sql_reader` role, and `sql_execute` runs under `api_sql_executor`. Reads and writes are separated on purpose.
- A tool call carries exactly one statement on both surfaces. On the HTTP side, `/v1/sql/query` and `/v1/sql/execute` are single-statement too, while the compatibility-only `/v1/sql` route still accepts a semicolon-separated script. That asymmetry is intentional.

The web chat additionally dispatches `query_database`, the name its SQL tool had before the read/write split, because stored transcripts replay it into the model. It resolves to `sql_query` or `sql_execute` by statement kind and is never advertised.

## Multi-currency conversion

All amounts are stored in native currency only. No precomputed report-currency column exists on `ledger_entries`.

Conversion to the reporting currency uses a two-layer FX model:

1. `fx_rates_raw` stores canonical raw market rates against the internal pivot currency `USD`.
2. The worker rebuilds `fx_rates_daily`, which contains exact-date all-pairs rates for every supported `base -> quote` combination.
3. Weekend and holiday carry-forward are resolved during the rebuild, not inside dashboard queries.
4. The reporting currency is read from `workspace_settings` (per workspace) and passed to read queries as the `quote_currency`.
5. If an exact daily pair is missing, the converted amount is `NULL` and the UI surfaces an unconvertible warning.

## Auth model

Zero built-in auth logic. Two modes controlled by `AUTH_MODE` env var:

- `none` (the app has no built-in default and refuses to start without an explicit value; the local Docker compose file supplies `none` as its own default) — no authentication. userId is hardcoded to `"local"`, workspaceId is `"local"`, and all data belongs to this single workspace. Startup requires a local http `CORS_ORIGIN`, and it refuses a production build or a non-loopback `HOST` unless `ALLOW_INSECURE_NO_AUTH=true` opts in deliberately, as the local Docker stack does (production image bound to `0.0.0.0` inside the container, published on `127.0.0.1` only).
- `cognito` — passwordless Email OTP via Cognito (Essentials tier, USER_AUTH + EMAIL_OTP). Auth is handled by a standalone Hono service on `auth.*`. IdToken is stored in `session` cookie (Domain=baseDomain), verified by `CognitoJwtVerifier` in the web app. Extracts `sub` claim as userId. The browser keeps the active workspace in a `workspace` cookie; if it is missing or stale, the app resolves the newest accessible workspace or creates the first one automatically. Redirects to `auth.*/login` if the session cookie is missing or invalid. Open registration: anyone can sign up via Cognito — each user gets a first regular workspace plus workspace-scoped isolation via RLS.

Details in `apps/web/src/proxy.ts`.

## Deployment profiles

1. **Local** — Docker Compose: Postgres + web + worker + migrate init container. See `docs/deployment.md`.
2. **AWS** — CDK stack: ECS Fargate + RDS + ALB/Cognito + Lambda + WAF + monitoring. Images built in CI, pushed to ECR. `/api/live` is used for ECS and ALB liveness, while `/api/health` stays DB-backed and is checked after deploy to confirm readiness. The root domain (`domain.com`) redirects to `app.domain.com` via ALB rule. To serve your own site on the root domain, deploy it independently and point DNS there. Schema changes must stay backward-compatible for at least one deploy unless you use a separate two-phase rollout. See `infra/aws/README.md`.
