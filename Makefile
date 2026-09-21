# Local development stack. The development defaults (AUTH_MODE=none,
# ALLOW_INSECURE_NO_AUTH=true, CORS_ORIGIN=http://localhost:3000) live in
# infra/docker/compose.yml as `${VAR:-default}`, except AUTH_MODE and
# ALLOW_INSECURE_NO_AUTH, which use `${VAR-default}` so an explicit empty
# value is not replaced. These targets add no environment of their own, so
# anything you set in the shell or in infra/docker/.env wins over those
# defaults for any non-empty value, for example
# `CORS_ORIGIN=http://127.0.0.1:3000 make up`.
COMPOSE := docker compose -f infra/docker/compose.yml

.PHONY: up down migrate dev build lint selfhost-verify

up:
	$(COMPOSE) up -d

down:
	$(COMPOSE) down

migrate:
	$(COMPOSE) run --rm migrate

dev:
	$(COMPOSE) up

build:
	$(COMPOSE) build

lint:
	cd apps/web && npm run lint
	cd apps/worker && npm run lint

# End-to-end verification of the AUTH_MODE=proxy_jwt self-hosting path against
# infra/docker/compose.selfhost.yml. It brings that stack up behind a local
# fake edge in its own Compose project, runs the checks, and tears it down with
# its volume. It shares nothing with the development stack above, nothing with
# a real self-host deployment on this machine, and touches no application code.
# The fake edge's JWKS certificate is privately issued, and the stack is given
# its CA through the documented SELFHOST_EDGE_CA_DIR and NODE_EXTRA_CA_CERTS
# variables, so this default run needs no flag. Read
# scripts/selfhost-verify/README.md first.
selfhost-verify:
	node scripts/selfhost-verify/verify.mjs
