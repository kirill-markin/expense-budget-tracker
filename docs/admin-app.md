# Admin app

[`apps/admin/`](../apps/admin/) is a separate Next.js app at `admin.<domain>` with product analytics for the operators: [Level 1 metrics](../apps/admin/src/app/analytics/level-1-metrics/page.tsx) (new and returning people, UI in [`apps/admin/src/ui/`](../apps/admin/src/ui/)) and [Users](../apps/admin/src/app/users/page.tsx). On AWS it is its own ECS service (`AdminService` in [`compute.ts`](../infra/aws/lib/compute.ts)) behind the shared ALB, reached through the `AdminRoute` host rule in [`ingress.ts`](../infra/aws/lib/ingress.ts), logging to `/expense-tracker/admin`. The self-hosted stack creates its database role but does not run the app.

## Access model

- Every request passes [`apps/admin/src/proxy.ts`](../apps/admin/src/proxy.ts), which requires:
  - a verified Cognito session from the `session` and `refresh` cookies the auth service sets on `COOKIE_DOMAIN`, so admins sign in at `auth.<domain>` like everyone else;
  - a verified email listed in `ADMIN_EMAILS`, an environment variable of the admin service only, filled from the GitHub repository variable `CDK_ADMIN_EMAILS`; there is no admin table;
  - a GET or HEAD method; everything else gets 405.
- A signed-in person who is not an admin gets a 403 page.
- The app has no public API: its pages read the database on the server.
- `ADMIN_AUTH_MODE=none` admits every request as a local admin. It is for local development only: the dev script binds 127.0.0.1, and the proxy also refuses a non-loopback `Host`.
- The app connects as the role `admin_analytics` ([`0091`](../db/migrations/0091_admin_analytics_role.sql)). It can read only `analytics.user_open_days`, `analytics.user_track_days` and the `users` columns `user_id`, `email`, `created_at`, `first_seen_at`, `last_seen_at`: no workspace, ledger or chat data, and no writes.

## Data

Migration [`0090`](../db/migrations/0090_analytics_activity_days.sql) creates two tables with one row per person per UTC day:

- `analytics.user_open_days` — the person opened a surface that day:
  - `web` from [`provisioning.ts`](../apps/web/src/server/db/provisioning.ts);
  - `api` and `mcp` from [`openDayRecorder.ts`](../apps/sql-api/src/openDayRecorder.ts), after authentication.
- `analytics.user_track_days` — the person inserted a transaction that day, written by the `ledger_entries` trigger, so manual and AI-made inserts count the same.

Migration [`0092`](../db/migrations/0092_analytics_activity_backfill.sql) backfills the days before live recording, and that history is approximate:

- `users` first and last seen times and chat and telemetry activity count as `web` opens;
- a shared workspace attributes its tracked days to every member;
- already pruned history is not recovered.

Who counts: every report reads people through `counted_users` in [`countedUsers.ts`](../apps/admin/src/server/countedUsers.ts), which drops the `local` dev identity, `ADMIN_EMAILS` and `ANALYTICS_EXCLUDED_EMAILS`. On AWS the excluded list is the demo account `demoEmailDostip`, or empty when that is unset. Report queries live in [`apps/admin/src/server/reports/`](../apps/admin/src/server/reports/).

## Rollout

1. Set the GitHub repository variable `CDK_ADMIN_EMAILS` to a comma list of admin emails. The deploy fails with a clear error without it.
2. Make sure the Cloudflare Transform Rule that injects `x-origin-auth` covers `admin.<domain>` (see [Origin shared secret](../infra/aws/README.md#origin-shared-secret-cloudflare--alb)); otherwise the WAF blocks it.
3. Deploy by merging to `main`.
4. Only after the deploy that adds the `AdminRoute`, run `scripts/cloudflare/setup-dns.sh`, then `scripts/cloudflare/verify.sh` (commands in [step 6](../infra/aws/README.md#6-bootstrap-and-first-deploy)). DNS created earlier sends `admin.<domain>` to the web app's default ALB action.

If the deploy's migrate step fails with the 0092 lock-timeout error, nothing was changed and a rerun is safe. A long autovacuum on a source table is a typical cause: wait until `pg_stat_progress_vacuum` shows none, then run `gh workflow run deploy.yml --ref main`.

## Add or remove an admin

Change `CDK_ADMIN_EMAILS` and deploy (`gh workflow run deploy.yml --ref main`). Admins are also excluded from every report.

## Pitfalls for other CDK deployers

- An empty entry in `CDK_ADMIN_EMAILS`, such as `a@x.com,,b@x.com`, passes synth, but every admin request then fails with a configuration error ([`config.ts`](../apps/admin/src/server/config.ts)). `/health` does not evaluate the configuration, so the service still looks healthy: check `/expense-tracker/admin` after changing the variable.
- Without `demoEmailDostip`, `ANALYTICS_EXCLUDED_EMAILS` is empty and only admins and `local` are excluded.

## Local run

With the local Postgres from `make dev`, whose migrate step gives `admin_analytics` the password `admin_analytics`:

```bash
ADMIN_AUTH_MODE=none ADMIN_EMAILS=admin@example.com ANALYTICS_EXCLUDED_EMAILS= \
  ADMIN_ORIGIN=http://localhost:3001 \
  DATABASE_URL=postgresql://admin_analytics:admin_analytics@localhost:5432/tracker \
  npm --workspace expense-budget-tracker-admin run dev
```

Then open `http://localhost:3001`.
