# Self-hosting outside AWS

Run the whole product — browser app, OAuth authorization server, MCP server, machine API, FX worker and Postgres — from one Docker Compose stack behind an edge proxy that authenticates people and forwards a signed identity token.

This is `AUTH_MODE=proxy_jwt`. The deployment hosts no login of its own: the edge is the identity provider, and the containers verify its token. The AWS deployment in [`infra/aws/`](../infra/aws/README.md) is a different mode (`AUTH_MODE=cognito`) and shares nothing with this file.

Files:

| Path | What it is |
| --- | --- |
| [`infra/docker/compose.selfhost.yml`](../infra/docker/compose.selfhost.yml) | the stack |
| [`infra/docker/.env.selfhost.example`](../infra/docker/.env.selfhost.example) | every variable it needs |

## Before you start

- **The edge must terminate https.** Workspace bootstrap sets the `workspace` cookie with `Secure`. On plain http the browser drops that cookie, the app redirects to `/api/workspaces/bootstrap` again, and the bootstrap becomes a loop.
- **Start the stack in `proxy_jwt` from the first boot.** See [First boot](#first-boot) — trying it unauthenticated first and switching later throws the data away.
- **Keep the published ports behind the edge.** They bind to loopback by default. A request that reaches them directly skips every Access policy and gets only what the containers enforce themselves: the app and the auth service still verify the token's signature, but the app's own public paths and the whole `/v1` and `/mcp` surfaces answer such a request.

## Four hostnames

A single-host path layout is not supported. Three of the four hostnames are constrained by the code, not by convention:

| Variable | Value | Serves | Why it is fixed |
| --- | --- | --- | --- |
| `APP_HOST` | `app.example.com` | `web` | free-form; `app.` is the convention |
| `AUTH_HOST` | `auth.example.com` | `auth` | for an https deployment the auth service refuses to start unless `OAUTH_ISSUER` is exactly `https://auth.<domain>` with no port, and the machine API derives the MCP URL it advertises by rewriting that `auth.` prefix to `mcp.` |
| `MCP_HOST` | `mcp.example.com` | `mcp` | the same startup check requires `OAUTH_RESOURCE` to be exactly `https://mcp.<same-domain>/mcp`, and a `CHECK` constraint on `auth.oauth_connections.resource` accepts no other https shape |
| `API_HOST` | `api.example.com` | `api` | nothing validates it, but the browser app's discovery routes build the machine API URL they advertise as `api.` plus `AUTH_DOMAIN` without its `auth.` prefix, so any other value advertises a URL that does not resolve |

All four are served over https by the edge, on the default port.

## Start the stack

```bash
cp infra/docker/.env.selfhost.example infra/docker/.env.selfhost
$EDITOR infra/docker/.env.selfhost

docker compose -f infra/docker/compose.selfhost.yml \
  --env-file infra/docker/.env.selfhost up -d --build
```

Pass `--env-file` on every later command too, including `down`, `logs` and `exec`. The file is deliberately not named `.env`: Compose reads `infra/docker/.env` automatically, and that one belongs to the development stack.

Every variable in the env file is required and has no default, except `SELFHOST_BIND_ADDRESS`, the `SELFHOST_EDGE_CA_DIR` and `NODE_EXTRA_CA_CERTS` pair that lets `web` and `auth` trust a privately issued JWKS certificate, and the optional integrations at the bottom. A missing required value stops the command instead of starting a container with an empty setting.

Services and the ports they publish to the edge:

| Service | Port | Image |
| --- | --- | --- |
| `web` | 3000 | `apps/web/Dockerfile` |
| `auth` | 8081 | `apps/auth/Dockerfile` |
| `mcp` | 8082 | `apps/sql-api/Dockerfile`, `node dist/serve-mcp.js` |
| `api` | 8083 | `apps/sql-api/Dockerfile`, default command |
| `worker` | — | `apps/worker/Dockerfile` |
| `postgres`, `migrate` | — | `postgres:18.6` |

`AUTH_MODE` and the four `AUTH_PROXY_*` variables are set on `web` and `auth`, the two services that resolve a person's identity. `api`, `mcp` and `worker` read neither: their callers authenticate with an `ApiKey` or an OAuth Bearer token, not with the edge token.

Route the edge to the ports above by hostname: `APP_HOST` → 3000, `AUTH_HOST` → 8081, `MCP_HOST` → 8082, `API_HOST` → 8083. Forward the original `Host` header, and do not add or rewrite `Origin`: the MCP transport runs DNS-rebinding protection against `MCP_HOST`, and answers `403 invalid_request_source` to any `/mcp` request whose `Host` differs or whose `Origin` is present and is not `https://<MCP_HOST>`.

### Build-time network dependency

`apps/web/Dockerfile`, `apps/auth/Dockerfile` and `apps/sql-api/Dockerfile` all download the AWS RDS CA bundle from `truststore.pki.rds.amazonaws.com` during the build. This stack keeps that as is rather than maintaining a second set of images, and the bundle is unused at runtime here: the SQL API pool enables TLS only when `DB_SECRET_ARN` is set, the auth pool only when `DB_HOST` is set, the web pool only when `AUTH_MODE=cognito`, none of which holds in this stack. `NODE_EXTRA_CA_CERTS` is defined but empty on `web` and `auth`, and not defined at all on `api`, `mcp` and `worker`; Node ignores it either way. If you do set it, for a privately issued JWKS certificate, it names your own bundle, not this one — Node reads a single file. The cost is that `docker compose ... build` needs to reach that host.

### Migration role privileges

`scripts/migrate.sh` runs as the role in `MIGRATION_DATABASE_URL` — here `tracker`, the superuser the `postgres` image creates. That role also **owns** the `SECURITY DEFINER` helpers added by migrations `0079` and `0080`, and those read and write `public.users`, which has `FORCE ROW LEVEL SECURITY` with a single policy matching `user_id = current_setting('app.user_id', true)` — a setting the auth service never sets.

So the role that runs the migrations must be able to bypass row-level security on `public.users`: a superuser, or a role with `BYPASSRLS`. If you replace the bundled Postgres with your own and create that role yourself and it lacks the bypass, two things break, and only one of them is visible:

- `auth.get_oauth_owner_account_state` returns no row. The OAuth owner check reads that as a subject it has never seen, so it answers "active" — and a **disabled account keeps receiving OAuth credentials**. Nothing logs this.
- `auth.mirror_authenticated_user` cannot write the mirror row at all: the policy's `WITH CHECK` is evaluated before the row reaches any index, so every call fails, including the `auth.sync_authenticated_user` that delegates to it. OAuth consent then fails outright rather than degrading, and the helper's own handling of a permanent `idx_users_email` collision is never reached.

The repository's Postgres tests run against a database whose definer is the superuser that applied the migrations, so they cannot catch a definer without the bypass. Verify it once, on the database you actually run.

## Edge proxy: Cloudflare Access

Any gateway that mints an RS256 JWT with `sub`, `email` and a numeric `exp` works — the verification is vendor-neutral, and a 60-second clock-skew grace is the only tolerance. What the gateway must also give you is an https JWKS endpoint whose certificate the containers can verify: Cloudflare Access is served by a public CA and needs nothing further, while a gateway of your own may need [A gateway of your own](#a-gateway-of-your-own). Cloudflare Access is the configuration below.

1. Create a **self-hosted Access application** covering `APP_HOST` and `AUTH_HOST`. Put both hostnames in one application so they share one audience tag; with two applications, set `AUTH_PROXY_JWT_AUDIENCE_APP` and `AUTH_PROXY_JWT_AUDIENCE_AUTH` to their respective tags.
2. Add the policy that decides who may sign in.
3. Add the bypass rules in the next section, as their own Access policies or applications scoped to those paths.
4. Fill in the env file:

| Variable | Cloudflare Access value |
| --- | --- |
| `AUTH_PROXY_JWT_HEADER` | `cf-access-jwt-assertion` |
| `AUTH_PROXY_JWKS_URL` | `https://<your-team>.cloudflareaccess.com/cdn-cgi/access/certs` |
| `AUTH_PROXY_JWT_ISSUER` | `https://<your-team>.cloudflareaccess.com` |
| `AUTH_PROXY_JWT_AUDIENCE_APP` | the application's audience (AUD) tag |
| `AUTH_PROXY_JWT_AUDIENCE_AUTH` | the same tag, or the auth application's own |

The header name and the URL shapes in this table, and the claim names Cloudflare puts in the token, are Cloudflare's own and are not checked against this repository's code. See [Verification status](#verification-status).

Leave `SELFHOST_EDGE_CA_DIR` and `NODE_EXTRA_CA_CERTS` unset: the `cloudflareaccess.com` certificate is publicly trusted, so the containers verify the JWKS fetch with the trust store they already ship.

`API_HOST` and `MCP_HOST` are not behind Access at all: both are machine surfaces with their own credentials.

## A gateway of your own

Everything above except the Cloudflare-specific values holds for any other gateway — oauth2-proxy, Authelia, Keycloak behind a reverse proxy, an in-house one. Two things about the JWKS endpoint are worth settling before the first boot, because both fail the same way: every request is answered 401, and each service logs it under its own action. Grep `web` for `{"domain":"auth","action":"proxy_auth_error", ...}` and `auth` for `{"domain":"auth","action":"proxy_identity_rejected", ...}` — same domain, same error string, two different action names. A silent `auth` container is not a healthy one; it is failing the same fetch and answering 401 on `/oauth/authorize`.

- **`AUTH_PROXY_JWKS_URL` must be https.** A plain-http URL is refused before any request goes out, with `Protocol "http:" not supported. Expected "https:"`.
- **Its certificate must verify.** Behind internal PKI it does not, and the error is `Failed to fetch https://…: self-signed certificate in certificate chain`. Give the containers the issuing CA:

```
# in infra/docker/.env.selfhost
# with the bundle copied into infra/docker/selfhost-ca
SELFHOST_EDGE_CA_DIR=./selfhost-ca
NODE_EXTRA_CA_CERTS=/etc/ssl/selfhost-ca/internal-root.pem
```

`SELFHOST_EDGE_CA_DIR` is a directory on the host — an existing one, and a directory, not the bundle file; Compose mounts **all of it** read-only on `web` and `auth` — the two services that verify the edge token — at `/etc/ssl/selfhost-ca`. It must therefore hold certificate material and nothing else: every file in it is readable inside both containers, so an internal PKI's own state directory, whose private keys are the point of it, is the wrong thing to name here. Copy the bundle into a directory kept for that alone. The repository ships one — `infra/docker/selfhost-ca`, the default when the variable is unset, relative to `infra/docker/` as in the example above; its contents are gitignored, and `.dockerignore` keeps them out of the build context too. `NODE_EXTRA_CA_CERTS` is the path inside the container, so it must name that mount point plus the file: a host path does not exist there. Node reads exactly one file, so concatenate the certificates if the chain needs more than one.

`web` and `auth` run as a non-root user, which has to traverse the mount and read the bundle — `chmod a+rx` that dedicated directory and `a+r` the bundle file in it. Nothing above or beside it needs widening; that is the second reason not to point the variable at a directory shared with anything else. Both paths must also be right: a path that does not exist, a path that is a file, an unreadable bundle (Node logs only `Ignoring extra certs` and falls back to its default store), or the wrong certificate all produce the same 401 as supplying no CA at all.

This extends the trust store; it does not weaken it. It is not scoped to the JWKS fetch either: `NODE_EXTRA_CA_CERTS` widens trust for every outbound TLS connection `web` and `auth` make, the OpenAI and Langfuse integrations further down the env file included, so name a CA you are willing to trust for all of their egress. There is no setting here that skips certificate verification, and a self-hosting deployment should not want one: the JWKS is the only thing standing between a forged header and an identity.

## What must bypass the edge

An agent has no Access session and cannot obtain one. These paths must be reachable without one, or MCP cannot work:

| Host | Path | Why |
| --- | --- | --- |
| `MCP_HOST` | `/mcp` | the MCP transport itself; the client presents an OAuth Bearer token, which the server validates against the database on every request |
| `MCP_HOST` | `/.well-known/oauth-protected-resource/mcp` | RFC 9728 protected-resource metadata; the client reads it before it has any credential (a `/.well-known/oauth-protected-resource/*` rule is fine — this is the only path served under it) |
| `AUTH_HOST` | `/.well-known/oauth-authorization-server` | authorization-server metadata, read the same way |
| `AUTH_HOST` | `/oauth/register` | Dynamic Client Registration; the client has no identity yet by definition |
| `AUTH_HOST` | `/oauth/token` | the code and refresh exchanges, made by the client process, not by a browser |

These must **stay behind Access**:

| Host | Path | Why |
| --- | --- | --- |
| `AUTH_HOST` | `/oauth/authorize` (`GET` and `POST`) | this is where the person's identity is established. The consent page and its submission read the edge token, and with no valid token they answer 401 and issue nothing |
| `AUTH_HOST` | everything else | in `proxy_jwt` the auth service registers only `/health` and `/robots.txt` beyond the rows above; bypass those two as well if you want to reach them from outside |
| `APP_HOST` | everything else | the browser app has no login of its own |

Bypassing `/oauth/authorize` removes the only identity source this mode has, so consent answers 401 and the OAuth flow can never complete. It does not open the endpoint up: a forged header does not help either, since the token is verified RS256 against the configured JWKS, issuer and audience.

`API_HOST` is reachable without Access in its entirety: its discovery routes are public by design, and every other route requires an `ApiKey` and is refused without one. Read [What is not supported](#what-is-not-supported) before relying on it.

### Optional: public share links

Public monthly share links are off by default here: `/share/monthly/<id>` and `/api/share/monthly/<id>` are public in the app's own gate, but Access sits in front of it, so an anonymous visitor never reaches them.

To enable the feature, add these bypass paths on `APP_HOST`:

```
/share/monthly/*
/api/share/monthly/*
/_next/static/*
/favicon.ico
```

The first two are the page and the route it fetches earlier months from. The last two are needed because the share page is a client component with a CSS module: with the bundle behind Access the visitor gets unstyled, unhydrated HTML and an Access redirect for every chunk. Both are build output and carry no workspace data, and the app's own gate already exempts them, so Access is the only thing in front of them. The gate's third exemption, `/_next/image*`, serves optimized images this page does not use; add it too if you customize the page to use them.

This widens the unauthenticated surface of your deployment: anyone with a link, or anyone who guesses one, reads that month's shared data without signing in. Add them only if you want the feature.

The app's own gate treats five more paths as public, and each may be bypassed at the edge if you want it reachable from outside: `/api/live` and `/api/health` for external monitoring, `/api/agent` and `/.well-known/agent.json` for agent discovery, and `/api/auth/logout`. None of them are required, and none of them read workspace data.

### Optional hardening

Cloudflare Access can require a **service token** — a client ID and secret header pair — on the bypassed MCP paths, as a Service Auth policy rather than a plain bypass. That adds a second credential in front of `/mcp` without requiring a browser session. It only works with clients you configure yourself, since a client that cannot be told to send those two headers can no longer reach the endpoint, and the OAuth discovery, registration and token paths need the same treatment or the flow stops before it starts. This paragraph is Cloudflare-specific and, like the table above, is not checked against this repository's code.

## Revoking access

Connect as `tracker`, the superuser. `public.users` has `FORCE ROW LEVEL SECURITY` with a policy scoped to one subject at a time, and the `auth` schema tables are granted to the service roles only, so no single application role can run all four statements below:

```bash
docker compose -f infra/docker/compose.selfhost.yml \
  --env-file infra/docker/.env.selfhost exec postgres psql -U tracker -d tracker
```

```sql
-- 1. Find the subject.
SELECT user_id, email, cognito_status, cognito_enabled
FROM public.users
WHERE email = 'person@example.com';

-- 2. Disable the account. This is the lever.
UPDATE public.users
SET cognito_enabled = false, updated_at = now()
WHERE user_id = '<user_id>';

-- 3. Kill the OAuth credentials they already hold.
UPDATE auth.oauth_connections
SET revoked_at = now(), updated_at = now()
WHERE user_id = '<user_id>' AND revoked_at IS NULL;

-- 4. Kill the agent API keys they already hold. This mode cannot create one,
--    so a row exists only from a stack previously run under AUTH_MODE=cognito.
UPDATE auth.agent_api_keys
SET revoked_at = now()
WHERE user_id = '<user_id>' AND revoked_at IS NULL;
```

What each part does, and does not do:

- **`cognito_enabled = false` cuts the machine API, the app's agent routes and MCP on the next request.** The `/v1` machine API answers `403 account_disabled`, the app's `/api/agent/*` routes answer the same, and the MCP access-token gate answers `401 invalid_token`. The auth service also stops issuing, exchanging and refreshing OAuth credentials for that subject, and each of those three attempts revokes their active connections on the way out. Nothing raises the flag back: since migration `0080`, no writer updates `cognito_status` or `cognito_enabled` for a row that already exists — not browser provisioning, not API-key authentication, not OAuth consent.
- **It does not cut the browser session.** In `proxy_jwt` a browser request is authenticated by the edge token and nothing else; no request path reads account state for it. Cutting someone out of the UI is an action at the identity provider, not in the database.
- **Deleting the `public.users` row is not a revocation mechanism.** For anyone who has actually used the product it will not even run: `workspace_members` and `user_settings` reference `users(user_id)` and neither cascades, so the `DELETE` is refused. And if you cleared those rows too, the deletion would not hold: in this mode a missing row is read as a first sighting, so the next browser request re-creates it enabled with status `PROXY`, and the OAuth owner check reads the absence as an active account. Use step 2.
- **Steps 3 and 4 are separate on purpose.** Step 2 makes every existing credential be *refused*; steps 3 and 4 make them *dead*. Revoking an OAuth connection invalidates its access tokens immediately, because token validation joins on the connection still being unrevoked.

Removing the person at the identity provider is a different lever again. It stops new sign-ins; whether an edge session they already hold ends immediately is the proxy's behavior, not this product's. What it does not do is reach an OAuth refresh token that was already issued, which stays valid for up to 30 days on its own. Only step 2 or step 3 ends that, and both are checked on every refresh exchange.

## What is not supported

- **No deployment without an edge proxy.** In `proxy_jwt` neither the app nor the auth service hosts a login. Without a proxy minting the token, every browser request is 401, forever.
- **No local password or email OTP login.** In `proxy_jwt` the auth service does not register `/login`, `/api/send-code` or `/api/verify-code` at all; they answer 404. No dormant email login is left behind the proxy.
- **No mixing of auth modes.** `AUTH_MODE=cognito` requires a Cognito user pool, and `AUTH_MODE=none` is unauthenticated; this stack pins `proxy_jwt` on both services that read identity.
- **No plain http.** See [Before you start](#before-you-start).
- **No agent API keys, so the `/v1` machine API is not usable here.** The only code path that issues one is `POST /api/agent/verify-code` on the auth service, and `proxy_jwt` does not register it. The web UI lists and revokes agent connections but cannot create a key. The `api` service still runs and answers its public discovery routes — and its discovery response still advertises the email OTP onboarding that this mode removed — but every authenticated route answers `missing_api_key`. Machine access in this deployment is the MCP server.

## First boot

Bring the stack up in `proxy_jwt` the first time. Running it unauthenticated first and switching later does not carry anything over:

- Under `AUTH_MODE=none` the app is always the pre-seeded subject `user_id = 'local'` in the pre-seeded workspace `local`, both created by the migrations. Everything you enter belongs to them.
- Under `proxy_jwt` your identity is the edge token's `sub`, a different subject, first seen in this mode and provisioned with status `PROXY` in a new workspace of its own. It is not a member of workspace `local`, and the product exposes no way to add a member to an existing workspace.
- Subject `local` carries `cognito_status = 'LOCAL'`, which is not in the active-status allowlist, and since migration `0080` no writer ever changes that column, so no product code path makes MCP admit it. Nor does the browser reach that data: the app accepts a `workspace` cookie only in UUID form, and workspace `local` is not one.

So the data entered under `AUTH_MODE=none` is unreachable after the switch. Your real account is not stranded — it is simply a different account.

## Verification status

The code this guide describes is merged and read back from the repository: the container entry points, the `proxy_jwt` mode in both services, the OAuth hostname checks, the MCP status allowlist and host validation, the account-state helpers in migrations `0079` and `0080`, and each refusal named in [Revoking access](#revoking-access).

The stack as a whole is run end to end by [`scripts/selfhost-verify`](../scripts/selfhost-verify/README.md), on one machine with Docker and no cloud account: `make selfhost-verify` brings up this very compose file against a local edge that mints RS256 tokens over a JWKS of its own, runs eleven checks, and tears the project down with its volume. Those checks cover the trust extension above and the identity it protects, the edge's stripping of a forged identity header, the 401 on a direct request that bypasses the edge, the whole MCP OAuth flow through to a working token and tool calls, revocation on the next request after the user is disabled, the `/v1` discovery envelope, the payload limits, and the isolation of the pre-seeded `local` workspace from a `proxy_jwt` identity. A green run is a statement about the stack as shipped: the harness configures it only through the variables `infra/docker/.env.selfhost.example` documents.

What it does not settle, and what the first real deployment therefore still tests: the harness mints the edge token itself, so the shape of a real Cloudflare token is unchecked; it never boots the stack under `AUTH_MODE=none` first; and it is not a browser, so the `__Host-csrf` behavior over plain http stays a manual check. Its own README lists these. The negative case of the CA above is settled: with either variable removed, the first check fails on the self-signed chain, by hand, one run each.

Two things here are outside the repository and are not checked against it: the Cloudflare-specific values (header name, JWKS and issuer URL shapes, claim names, and the service-token note), and the behavior of an identity provider when you remove someone. A third, that `psql -U tracker` connects without a password from inside the `postgres:18.6` container, the harness now settles: every run reads the database that way.

That the bundled `tracker` role bypasses row-level security is settled: CI applies the migrations as `tracker` against the same `postgres:18.6` image, and `apps/auth/src/server/accountState.postgres.test.ts` then writes `public.users` through a definer owned by that role with no `app.user_id` set, which only passes if the definer bypasses RLS.
