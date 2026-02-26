# expense-budget-tracker

Self-hosted open-source expense and budget tracker with balances, transfers, and multi-currency reporting on Postgres.

![Budget view](docs/budget-screenshot.jpg)

**Live demo:** [expense-budget-tracker.com](https://expense-budget-tracker.com/)

## Features

- **Fully open-source** — all code is available, deploy on your own servers with full control over your data
- **Direct Postgres access** — connect your LLM with database credentials and let it query, analyze, and manage your financial data directly, bypassing the app and UI. Minimal, flat table structure designed to be hard to misuse — ideal for AI agents
- **Budget and transaction UI** — built-in interface for budgeting, browsing transactions, and tracking balances across accounts and currencies

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

## License

[MIT](LICENSE)
