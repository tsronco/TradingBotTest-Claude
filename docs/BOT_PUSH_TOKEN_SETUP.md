# BOT_PUSH_TOKEN setup

The dashboard's `/api/bot-state` webhook is bearer-token-protected. The token must
be set in TWO places — both must hold the same value:

1. **GitHub Actions secret** — `tsronco/TradingBotTest-Claude` → Settings → Secrets and variables → Actions → New repository secret
   - Name: `BOT_PUSH_TOKEN`
   - Value: the 64-char hex string you generated with `openssl rand -hex 32`

2. **Vercel environment variable** — Vercel project `dashboard` → Settings → Environment Variables
   - Name: `BOT_PUSH_TOKEN`
   - Value: the same 64-char hex string
   - Apply to: Production, Preview, Development

Rotate the token by:
1. Generate a new value.
2. Update Vercel first (so the dashboard accepts the new token).
3. Then update the GitHub Actions secret.
4. Trigger a workflow run to verify (`gh workflow run tsla-monitor.yml`).

## First-run backfill

Until each workflow has run at least once after deploy, the dashboard's
KV will be empty for those keys. To prime it manually:

```bash
gh workflow run tsla-monitor.yml
gh workflow run tsla-monitor-aggressive.yml
gh workflow run congress-copy.yml
```

Wait ~1 minute, then check that the dashboard's home page shows fresh data.
