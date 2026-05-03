# Trading Dashboard

Personal Vercel-hosted dashboard for monitoring the TradingBotTest-Claude bots and placing manual trades.
See [docs/superpowers/specs/2026-05-02-trading-dashboard-design.md](../docs/superpowers/specs/2026-05-02-trading-dashboard-design.md).

## Local development

```bash
npm install
cp .env.example .env       # then fill in real values
npm run dev                # Vite dev server on :5173
```

## Tests

```bash
npm test
```

## Deploy

This app is deployed to Vercel from the `dashboard/` subdirectory.
See [DEPLOY.md](./DEPLOY.md) (added in Task 38) for first-time setup.
