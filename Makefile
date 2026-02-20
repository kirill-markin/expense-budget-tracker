COMPOSE := docker compose -f infra/docker/compose.yml

.PHONY: up down migrate seed dev build test lint

up:
	$(COMPOSE) up -d

down:
	$(COMPOSE) down

migrate:
	$(COMPOSE) exec postgres sh -c 'for f in /migrations/*.sql; do psql "$$DATABASE_URL" -f "$$f"; done'

seed:
	$(COMPOSE) exec postgres psql "$$DATABASE_URL" -f /seeds/demo.sql

dev:
	$(COMPOSE) up

build:
	$(COMPOSE) build

test:
	$(COMPOSE) run --rm web npm test
	$(COMPOSE) run --rm worker python -m pytest

lint:
	$(COMPOSE) run --rm web npm run lint
	$(COMPOSE) run --rm worker python -m ruff check .
