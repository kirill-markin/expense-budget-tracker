# Local self-host verification

Runs the whole `AUTH_MODE=proxy_jwt` path from [`docs/self-hosting.md`](../../docs/self-hosting.md) on one machine, with Docker and no cloud account: a local edge mints signed JWTs against a local JWKS, the web app accepts the identity, the OAuth flow issues a real MCP access token, MCP tool calls succeed, and disabling the user kills MCP access on the next request.

```bash
make selfhost-verify
```

That brings up `infra/docker/compose.selfhost.yml`, starts the fake edge, runs the checks, and tears the stack down with its volume. **The default run stops at check 1 by design** — read [Why `--trust-edge-ca` exists](#why---trust-edge-ca-exists). Flags go through `node scripts/selfhost-verify/verify.mjs` directly:

| Flag | Effect |
| --- | --- |
| `--keep-up` | leave the stack running after the run, for debugging |
| `--trust-edge-ca` | the one deviation from the shipped stack — read [Why `--trust-edge-ca` exists](#why---trust-edge-ca-exists) before using it |

Needs:

- **Docker Desktop**, not stock Docker Engine. The containers fetch the JWKS from the host through `host.docker.internal`, and `compose.selfhost.yml` sets no `extra_hosts`, so on a Docker without that name the run stops at check 1 with a resolution error. The run tells that failure apart from the certificate gap below and says which one it hit.
- `openssl`, for the local CA and the edge certificate.
- Network access: the images download the AWS RDS CA bundle at build time, as `docs/self-hosting.md` describes.
- Free loopback ports `3000`, `8081`, `8082`, `8083` for the stack, `8443` and `8444` for the edge and its JWKS, and one ephemeral port the harness's echo upstream takes for itself.

It cannot disturb a real self-host deployment on the same machine. It runs in its own Compose project, `expense-budget-tracker-selfhost-verify`, rather than the `expense-budget-tracker-selfhost` project `compose.selfhost.yml` pins, and it writes its env file to `tmp/selfhost-verify/.env.selfhost` rather than over `infra/docker/.env.selfhost`, the file `docs/self-hosting.md` tells the operator to create with their own passwords.

Without `--keep-up`, everything under `tmp/selfhost-verify/` is written by the run, is gitignored, and is deleted at teardown together with the CA private key and the forged identity token, and the Compose project goes down with its volume. That teardown also runs on `SIGINT` and `SIGTERM` — but a second `SIGINT` while it is running aborts it part-way, and then the manual-removal commands the run prints are the fallback.

With `--keep-up` none of that happens: the project, its volume, `tmp/selfhost-verify/` with the env file, the CA private key and a still-valid forged identity token all stay on disk, and the fake edge keeps listening on `8443` and `8444` until it is killed. The run prints its pid and the compose commands that address this project. The echo upstream is the exception — it lives in the run's own process and stops with it, so `echo.selfhost.test` answers 502 afterwards.

The hostnames are `app|auth|api|mcp.selfhost.test`, plus `echo.selfhost.test` for the harness's own upstream; nothing resolves any of them, because the client sets `Host` itself and reaches the edge on `127.0.0.1:8443`.

## What it does not prove

The header name, the JWKS URL shape and the claim names are Cloudflare's own, and this harness sets all three itself. What it proves is the contract the containers verify — an RS256 token with `sub`, `email` and a numeric `exp`, from the configured issuer and audience, on the configured header — not that Cloudflare Access produces one in that shape. A live Access tenant is still the only thing that settles that.

It also does not restart the stack under `AUTH_MODE=none`. Check 10 writes a row into the pre-seeded `local` workspace, which is the workspace that mode always runs in, and verifies the claim `docs/self-hosting.md` actually makes: that such data is unreachable from a `proxy_jwt` identity. A stack that really was booted in `none` first is still not exercised.

## The edge

`fake-edge.mjs` generates an RSA key pair with `node:crypto` at startup and serves the matching JWKS on its own port. It terminates https for the four deployment hostnames, and for the harness's own `ECHO_HOST` below — `openssl` issues a local CA and one leaf certificate, because Node can generate keys but cannot issue a certificate — and forwards to the loopback ports the compose file publishes, keeping the original `Host` and adding no `Origin`.

It deletes the identity header from every inbound request before it decides anything, so a header forged by the client can never reach a container, and then re-adds a freshly minted token only where `docs/self-hosting.md` puts the request behind Access:

| Host | Behind Access | Source |
| --- | --- | --- |
| `APP_HOST` | everything | "Edge proxy: Cloudflare Access" step 1, and the must-stay-behind table |
| `AUTH_HOST` | everything except `/.well-known/oauth-authorization-server`, `/oauth/register`, `/oauth/token` | the bypass table |
| `MCP_HOST` | nothing | "`API_HOST` and `MCP_HOST` are not behind Access at all" |
| `API_HOST` | nothing | the same sentence |
| `ECHO_HOST` | nothing | not a deployment hostname; see below |

`ECHO_HOST` is the harness's, not the guide's. The edge routes it to an echo server inside `verify.mjs` on an ephemeral loopback port, outside the Access application exactly like `MCP_HOST` and `API_HOST`, so the forwarded request can be read back. No container reflects the headers it received, so without this the strip could only be inferred, never observed — and it was twice asserted in places that could not have failed. Deleting the `delete headers[config.identityHeader]` line in `fake-edge.mjs` now fails check 2.

The guide's `/mcp` and `/.well-known/oauth-protected-resource/*` bypass rows have no entry in the edge's per-path bypass list: those paths live on `MCP_HOST`, which is outside the Access application entirely, so a per-path bypass for them could never be consulted. The optional share-link bypass paths are not enabled, matching the guide's default.

## The checks

| # | What it proves |
| --- | --- |
| 1 | A web request through the edge is answered 200 and provisions the edge subject with `cognito_status = 'PROXY'` and the token's email. |
| 2 | The forged identity header is live — presented straight at the web container it provisions a second account — and the edge nonetheless keeps it out: overwritten behind Access, and, on the bypassed `ECHO_HOST` where stripping is the only defence, never forwarded at all. The echo upstream reports the headers it received, on a `/.well-known/…` path and on a `/mcp` path, and the probe header it did receive is asserted too, so an empty answer cannot pass. |
| 3 | A non-public app path straight at the published `web` port, and `/oauth/authorize` straight at the published `auth` port, are both answered 401 with the shared unauthorized message, never a redirect. Public paths, `/v1` and `/mcp` answer a direct request by design, and so does `/api/live`, which the run itself waits on. |
| 4 | Discovery, dynamic client registration, the consent page, the consent submission and the token exchange all work through the edge, and the token endpoint issues an `ebt_at_` access token. |
| 5 | MCP `initialize`, `tools/list` and a `sql_query` tool call succeed with that token and return rows. |
| 6 | `UPDATE users SET cognito_enabled = false` cuts all three agent surfaces on the very next request — MCP `401 invalid_token`, `/v1` `403 account_disabled`, consent `access_denied` with no code — while the browser still answers 200, writes to the same row (`last_seen_at` advances), and leaves `cognito_enabled` false. |
| 7 | The token revoked by that refused consent stays dead, and re-enabling the row lets the whole OAuth flow issue a working token again. |
| 8 | `GET /v1/` answers the discovery envelope with the configured `api.` and `mcp.` URLs both through the edge and straight at the published port, where the `Host` is `127.0.0.1:8083` — which is the request an unset `PUBLIC_API_BASE_URL`/`PUBLIC_AUTH_BASE_URL` pair answers with a bare 500. |
| 9 | An oversized body is refused by the explicit payload limit on both `/v1` and `/mcp`, rather than buffered. |
| 10 | A row written into the pre-seeded `local` workspace is unreachable from the proxy identity: `sql_query` cannot select that workspace, the row is absent from the identity's own workspace, `list_workspaces` does not offer `local`, and the browser cannot make it the active workspace. |
| 11 | The MCP gate admits `'PROXY'` and denies any other stored status against a live database: renaming the stored value denies the same token, and restoring it admits the token again. |

Checks 6 and 9 share an agent API key seeded straight into `auth.agent_api_keys`, and the run says so in its output. `AUTH_MODE=proxy_jwt` registers no route that can create one — the only issuing path is the email OTP endpoint the mode removes — so "`/v1` cannot be reached because no key can be created" stays separate from "`/v1` does not work".

## Why `--trust-edge-ca` exists

**The default run fails at check 1, and that is a finding, not a bug in the harness.**

`AUTH_PROXY_JWKS_URL` is fetched by `aws-jwt-verify` through `node:https`. That rejects a plain-http URL outright:

```
{"domain":"auth","action":"proxy_auth_error","error":"Protocol \"http:\" not supported. Expected \"https:\""}
```

and it rejects an https URL whose certificate no public CA signed:

```
{"domain":"auth","action":"proxy_auth_error","error":"Failed to fetch https://host.docker.internal:8444/cdn-cgi/access/certs: self-signed certificate in certificate chain"}
```

Neither `compose.selfhost.yml` nor `.env.selfhost.example` exposes `NODE_EXTRA_CA_CERTS`, so nothing in the shipped stack can make a container trust a private CA. Cloudflare Access is unaffected — its JWKS is publicly trusted — but the guide's claim that "any gateway that mints an RS256 JWT with `sub`, `email` and a numeric `exp` works" does not hold for a self-hosted gateway behind internal PKI, which is a large part of who reads a self-hosting guide. It also means the guide's own advice to "treat the first deployment as the first test" cannot be followed locally.

`--trust-edge-ca` writes a compose override that mounts the fake edge's CA into `web` and `auth` and sets `NODE_EXTRA_CA_CERTS`, purely so checks 2 to 11 can be run at all. It is not part of the shipped stack. The run prints a banner saying so before the checks and again immediately before it exits, and prefixes every result line with `[--trust-edge-ca]`, so no excerpt of the output can be mistaken for the shipped stack working. **A green run under that flag does not mean the stack as documented works.**

## Manual check: Safari and `__Host-csrf` over plain http

Not scriptable here, and deferred from an earlier review. The web app's proxy sets its CSRF cookie as `__Host-csrf`, and the `__Host-` prefix requires `Secure`, so over plain http a browser refuses to store it and every mutating request is answered `403 CSRF validation failed`. Safari is the strictest about this and the one to check by hand. `docs/self-hosting.md` requires https at the edge for a different reason — the `Secure` `workspace` cookie — and this is a second reason for the same rule. This harness is not a browser: it keeps cookies in a map and sends them back regardless of their attributes, so it cannot see any of it.
