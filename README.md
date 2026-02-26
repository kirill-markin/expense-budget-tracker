# expense-budget-tracker

Self-hosted open-source expense and budget tracker with balances, transfers, and multi-currency reporting on Postgres.

![Budget view](docs/budget-screenshot.jpg)

## Quick start

```bash
git clone https://github.com/kirill-markin/expense-budget-tracker.git
cd expense-budget-tracker
open -a Docker   # start Docker if not running (macOS)
make up          # start Postgres, run migrations, start web + worker
```

Open `http://localhost:3000`.

## Documentation

- [Deployment](docs/deployment.md) — local Docker Compose and AWS CDK setup
- [AWS deployment](infra/aws/README.md) — full AWS CDK guide

- [Architecture](docs/architecture.md) — system overview, data model, multi-currency design
