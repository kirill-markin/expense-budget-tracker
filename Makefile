COMPOSE := docker compose -f infra/docker/compose.yml

.PHONY: up down migrate dev build test lint

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

test:
	$(COMPOSE) run --rm web npm test
	$(COMPOSE) run --rm worker npm test

lint:
	cd apps/web && npm run lint
	cd apps/worker && npm run lint
