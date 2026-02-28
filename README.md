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

## Usage with AI agents

1. **Settings → Direct Database Access → Generate credentials** — copy the connection string (shown once)
2. **Give the connection string to your AI agent** — [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://openai.com/index/codex/), or any agent that can run SQL
3. **Send the agent screenshots, CSV files, or PDF bank statements** — it parses them and inserts transactions into the database
4. **Open the web UI** — view actual spending by category and plan the budget for the next month

Example SQL the agent runs:

```sql
INSERT INTO ledger_entries (event_id, ts, account_id, amount, currency, kind, category, counterparty, note)
VALUES
  ('evt-001', '2025-03-15 12:30:00+00', 'chase-checking', -42.50, 'USD', 'spend', 'groceries', 'Whole Foods', 'Weekly groceries'),
  ('evt-002', '2025-03-15 09:00:00+00', 'chase-checking', -5.75,  'USD', 'spend', 'coffee',    'Blue Bottle',  NULL);
```

## Documentation

- [Deployment](docs/deployment.md) — local Docker Compose and AWS CDK setup
- [AWS deployment](infra/aws/README.md) — full AWS CDK guide

- [Architecture](docs/architecture.md) — system overview, data model, multi-currency design

## Security considerations

The hosted demo at [expense-budget-tracker.com](https://expense-budget-tracker.com/) has known limitations you should be aware of:

1. **Demo instance data visibility.** Kirill Markin (the maintainer) has full access to the demo instance database. If you want complete privacy, deploy on your own infrastructure — the project is fully open-source and self-hostable. If you are fine with the maintainer potentially seeing your data, use a secondary email without your real name — but understand that it is hard to fully hide data from the server owner.

2. **Postgres port is exposed publicly.** To allow external BI tools (Metabase, Grafana, Tableau, etc.) to connect directly, the AWS-managed Postgres instance has its port open to the internet. Credentials are auto-generated long passwords that are not stored anywhere after initial creation, and row-level security is enforced per user. Still, exposing a database port publicly is not a best practice — this is a known trade-off under active consideration.

3. **Maintainer uses this for his own finances.** Kirill Markin stores his own real financial data on the same infrastructure. This means the service is actively maintained and kept secure — the maintainer has direct skin in the game.

For maximum security, self-host the stack on your own AWS account using the included [CDK deployment guide](infra/aws/README.md).

## License

[MIT](LICENSE)
