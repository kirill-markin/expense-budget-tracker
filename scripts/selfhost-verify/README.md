# Local self-host verification

Runs the whole `AUTH_MODE=proxy_jwt` path from [`docs/self-hosting.md`](../../docs/self-hosting.md) on one machine, with Docker and no cloud account: a local edge mints signed JWTs against a local JWKS, the web app accepts the identity, the OAuth flow issues a real MCP access token, MCP tool calls succeed, and disabling the user kills MCP access on the next request.

```bash
make selfhost-verify
```

That brings up `infra/docker/compose.selfhost.yml`, starts the fake edge, runs the checks, and tears the stack down with its volume. The stack is configured only through the variables `infra/docker/.env.selfhost.example` documents — including the two that make it trust the edge's privately issued JWKS certificate, see [The privately issued JWKS](#the-privately-issued-jwks) — so a green run is a statement about the stack as shipped. One flag goes through `node scripts/selfhost-verify/verify.mjs` directly:

| Flag | Effect |
| --- | --- |
| `--keep-up` | leave the stack running after the run, for debugging |

Needs:

- **Docker Desktop**, not stock Docker Engine. The containers fetch the JWKS from the host through `host.docker.internal`, and `compose.selfhost.yml` sets no `extra_hosts`, so on a Docker without that name the run stops at check 1 with a resolution error. The run tells that failure apart from a certificate failure and says which one it hit.
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
| 1 | `web` fetches and verifies a JWKS served under a certificate no public CA signed, and a request through the edge is answered 200 and provisions the edge subject with `cognito_status = 'PROXY'` and the token's email. |
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

Checks 6 and 9 share an agent API key minted through the app's own `POST /api/agent-connections` route, on the browser session check 1 established. That route is the only issuing path this mode has, since it registers no email OTP endpoint, so the key both checks use is itself evidence that `/v1` is reachable here. The helper also asserts that the stored `key_hash` is the sha256 of the issued secret: the plaintext is returned once and never kept.

## The privately issued JWKS

`AUTH_PROXY_JWKS_URL` is fetched by `aws-jwt-verify` through `node:https`, which verifies the certificate like any other https client. The fake edge issues its own CA and serves the JWKS under it, so this harness is exactly the case a self-hosted gateway behind internal PKI is in, and without the CA the run stops at check 1:

```
{"domain":"auth","action":"proxy_auth_error","error":"Failed to fetch https://host.docker.internal:8444/cdn-cgi/access/certs: self-signed certificate in certificate chain"}
```

A plain-http JWKS URL is refused before that, by the same library:

```
{"domain":"auth","action":"proxy_auth_error","error":"Protocol \"http:\" not supported. Expected \"https:\""}
```

The run answers the first of the two with the same two variables [`docs/self-hosting.md`](../../docs/self-hosting.md) gives an operator in [A gateway of your own](../../docs/self-hosting.md#a-gateway-of-your-own), written into the env file it generates:

```
SELFHOST_EDGE_CA_DIR=<repo>/tmp/selfhost-verify/ca
NODE_EXTRA_CA_CERTS=/etc/ssl/selfhost-ca/edge-ca.pem
```

`compose.selfhost.yml` mounts that directory read-only on `web` and `auth` at `/etc/ssl/selfhost-ca`. Only the CA certificate is copied into it; the CA private key stays one directory up in `tmp/selfhost-verify/`, which is mounted nowhere, and `.dockerignore` excludes `tmp/` so neither file reaches the build context or an image layer either. Check 1 is therefore a check of the trust extension and not only of the identity: it passes only because the stack was given the CA.

Both halves of that were exercised by hand, one run each, and both fail check 1 with the certificate error above. Dropping `NODE_EXTRA_CA_CERTS` leaves the CA mounted but unnamed, so Node never reads it. Dropping `SELFHOST_EDGE_CA_DIR` instead leaves the variable naming `/etc/ssl/selfhost-ca/edge-ca.pem` while the mount falls back to the empty `infra/docker/selfhost-ca`, so the file is absent and Node only warns — `Ignoring extra certs from …, load failed: … No such file or directory` — and verifies against its default store, which is the same 401. An unreadable bundle warns the same way, with `Permission denied`, which is why the run gives that directory `0755` and the file `0644` rather than leaving them to the process umask.

The harness has no flag for either case, and needs none: `verify.mjs` inherits the shell's environment, and `docker compose` ranks a shell variable above `--env-file`, so setting one empty in front of the command is enough. `compose.selfhost.yml` writes both as `${VAR:-…}`, which treats empty as unset, so each command below reproduces one half:

```
SELFHOST_EDGE_CA_DIR= node scripts/selfhost-verify/verify.mjs
NODE_EXTRA_CA_CERTS= node scripts/selfhost-verify/verify.mjs
```

Nothing has to be prepared or kept for this. Both runs generate their own `tmp/selfhost-verify/`, and both delete it at teardown along with the env file and the CA, the same as any run without `--keep-up`.

This extends the trust store. Nothing here, and nothing in the stack, disables certificate verification.

## Manual check: Safari and `__Host-csrf` over plain http

Not scriptable here, and deferred from an earlier review. The web app's proxy sets its CSRF cookie as `__Host-csrf`, and the `__Host-` prefix requires `Secure`, so over plain http a browser refuses to store it and every mutating request is answered `403 CSRF validation failed`. Safari is the strictest about this and the one to check by hand. `docs/self-hosting.md` requires https at the edge for a different reason — the `Secure` `workspace` cookie — and this is a second reason for the same rule. This harness is not a browser: it keeps cookies in a map and sends them back regardless of their attributes, so it cannot see any of it.
