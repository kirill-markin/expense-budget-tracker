COMPOSE := docker compose -f infra/docker/compose.yml

.PHONY: up down migrate dev build lint

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
